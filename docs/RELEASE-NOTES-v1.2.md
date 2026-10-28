# cf-gitea v1.2 — Release Notes

Snapshot 2026-10-27, HEAD `640005b` — the post-v1.1 window (198 commits,
`4f59daa`→`640005b`, 2026-10-26 20:58 – 2026-10-27 19:46 +0800): the
port-first UI endgame completes with the dispatchable board EMPTY, the
full-suite gate is redefined (`pnpm test:full`, ADR-0006) after the ws1009
runner-death class was measured, falsified-against, root-fixed and filed
upstream, and REDEPLOY17–20 ship four deploy windows including one 14-minute
production incident and two live bug verdicts (#19 real and fixed in-flight,
#20 reversed as a probe bug). Every number below is either quoted from the
authoritative doc that recorded it or anchored to the commit that landed it —
nothing was re-measured for these notes.

**Cut point.** The v1.1 notes close at Addendum 3 (`4f59daa`), written against
tree `58c6cf0` with survey tick-6 (`7a5861e`) landed and REDEPLOY17 marked
"deploying". REDEPLOY17 actually shipped from `7cd1ce9` minutes later (its
evidence block `96cb9d4` opens this window's record). Everything from
`bff7fdc` (tick-7) to `640005b` (the upstream ws1009 filing, current HEAD) is
the delta these notes cover — 198 commits, twice the brief's estimate; the
ledger below accounts for the whole range.

A separate v1.2 doc rather than a fourth addendum to v1.1: the v1.1 file's
addenda exist to keep one session's snapshot honest as its deploys landed; this
delta is a distinct session with its own deploy era and its own structural
verdicts, so it gets its own numbered snapshot (the v1.0→v1.1 precedent).

---

## 1. What v1.2 is

### The port-first endgame (Web UI)

The two-stage program that v1.1's ticks left in flight completed inside this
window, in two passes.

**Stage 1 — the module mega-wave and the first mount window (late 10-26
through early 10-27).** Seventeen two-stage modules landed unmounted
(user-settings tab family, org blocked-users/actions tabs, admin dashboard +
monitor group, four repo-settings tabs, the wiki family flagship `5a0b0ef`,
the sitemap family `1192d9c`, the search aux feeds `d07711f`/`b4e18db`, the
compare byte feeds `ef1aaa4`, the merge-box fragment `a9ceff3`, the issue
info/attachments/content-history fragments `7292f39`, the global inbox
`e669f82`, the .rss/.atom envelopes `efce750`, the editor staging family
`dc9ff97`, cherrypick/patch `e4dba90`, branches writer arms `2995e02`, the
upload tails `f4492b2`) and then MOUNTED in fourteen window commits,
sub-waves 2a–2f, **92 routes**: window-2a the user-settings tab family (8
modules, 19 routes, `0c2b151`); 2b org blocked-users + actions
secrets/variables (9, `4f2805f`); 2c the admin group (7, `e31c0cf`); 2d four
repo-settings tabs (13, `b54f709`) + the wiki-config arm (2, `46e7e68`); 2e in
eight slices (sitemap + search aux 6 `84996c6`; global inbox 3 `a8818c6`;
.rss/.atom envelopes 1 `1a59af0`; repo-scoped aux feeds + fragments 11
`22599e4`; the wiki family 4 `9516bf1`; editor tails + cherrypick/patch 8
`1d834d6`; the migration page 2 `62ef380`; subscriptions/watching tails 2
`5ca1727`) plus the folds `635ce2e`; then 2f — the 13-site shared-navbar swap
(`94c6851`) and the SettingsNav fold (`d32db26`, scaffold navs deleted). One
deliberate non-mount: the profile `?tab=activity` arm (its seam landed into
the feed envelopes instead) — mounted later at `b1bf73a`, the survey's last S
bench row. (The full cargo manifest is REDEPLOY20's pre-deploy evidence block
in `docs/design/p0-evidence.md`.)

**The deferred-matrix program walked every mounted page**: 52 matrix commits
whose subjects tally **~1,170 cases**, catching **18 real UI bugs**, all
fixed in-window. The headline classes, verbatim from the evidence block:

- **The dead-route class (four, one lesson):** the mounted wiki family was
  UNREACHABLE — parse + registration order unshadowed (`a58cad5`);
  `/repo/search` + `/repo/migrate` shadowed by the dynamic owner/repo block
  (`f60e5a8`); the pulls/new redirect dead behind its own parse claim
  (`3837c17`); issues/search + suggestions under the `/:index` catch
  (`c4a1723`). Process note recorded in the survey: **module-green is not
  route-live** — static literals register ahead of any dynamic segment that
  could shadow them.
- **The security pair:** the cherrypick/patch POST arms gained
  sameOriginGuard — CSRF closed (`27aa538`); the session clear-cookie
  directive was double-wrapped on EVERY UI page (`dee8cf0`).
- **The wire-format divergence:** PR comments anchored under /issues —
  commentHtmlUrl's is_pull branch (`89589b3`).
- **The rendering-ladder class:** merged PRs say merged (`6ecb21c`); the
  comment block's archived/locked ladder (`a12ecdf`); archived mirrors render
  the warning ONLY (`cdde728`); archived branches hide delete (`234ee49`);
  the conditional Public Access item (`364bf92`).
- **The stale-pin sweep:** `docs/compat/stale-pin-sweep.md` + ~18 more
  pin/golden updates (`04d80b3`, `2c7c05f`, `e2cade9`, `9400ab6`, `8196440`
  among them).

**Stage 2 — the wave-124..126 endgame and THE MOUNT WINDOW.** Twelve modules
landed committed-unmounted, HANDOFF-exact: the tags feed tails `df82166`, the
releases feed tails `06a2355`, the wiki raw byte arm `dc477aa`, the profile
followers/following tabs `0968117`, profile stars `c66fe23`, profile watching
`cf62b79`, settings account `78a1b68`, settings notifications `bf69f6c`
(SPEC-first prefs store, migration 0034), issue content-history `cced424`
(SPEC-first snapshot store + hooks + both fragment arms, migration 0033), the
admin users/orgs/repos trio `9ad5d15`, milestone detail `9468587`, and
settings repos `03ef47c`. Then, per the verified plan
`docs/plans/mount-window-wave126.md` (12 recipes cross-checked at HEAD, zero
blockers): **THE MOUNT WINDOW `2f7afe9` — 11 modules live, 8 folds, 62 ops in
one index.ts pass** with zero anchor drift; the hono-vs-chi EMPTY-TAIL bug
found and fixed at the mount (bare `/wiki/raw` keeps its own registration to
hold the 303); window verification 188/188 across the ten key suites, solo
290/290. The follow-up `484eb92` mounted settings repos per `03ef47c`'s
HANDOFF. The plan's one mission-list correction: milestone-detail was already
mounted (§5.1).

**Survey tick-12 (`b12bd95`, at `484eb92`): 116 rows — 91 LANDED / 5 PARTIAL
/ 20 ABSENT, zero IN-FLIGHT, and the dispatchable board is EMPTY** (`docs/compat/ui-parity-survey.md`).
"Parity complete" for the demand-driven phase now means exactly this: every
row dispatchable as pure UI work over landed data is LANDED; every remaining
row is needs-API-first (org dashboard/issues groups, `/user/sign_up`,
`/explore/organizations`'s anonymous arm, `settings/lfs` pointer scans, the
org applications/audit_logs tabs, the admin pages beyond
dashboard/monitor/listings), FEATURE-ABSENT-gated (everything
actions/packages), or no-RPC-gated (blame, graph, code search, heatmap,
audit_logs). The landed set covers every highest-traffic page — the full
enumeration is the tick-12 totals section.

### API surface: unchanged at the ceiling

`node scripts/check-openapi.mjs` PASS throughout the window — declared
**490 operations / 298 paths** (88.4% of the frozen 554-op contract; tier-1
78/78 paths, 129/129 ops), re-run at tick-12 (`b12bd95`) and at both RD20
deploy gates (`03f9e82` pre-deploy evidence; GO `50479cb` per the RD20 paste
2). The window's API work (SPEC-0005 below, the payload/read-gate closures
`3fcbe1a`/`a55a725`, the renamed-fork fork-edge `9ecb3e5`, search filters
`e39adad`) added **zero declared operations**: the surface sits at the
pre-Actions/packages ceiling — 64 remaining, all FEATURE-ABSENT (§4).

### SPEC-0005 — collaborator visibility (`6c3481f`)

One fold, three surfaces: `doerRepoAccessMode` now ranks
max(org-owner bridge, team arm, collaborator arm) — an active
`repo_collaborators` row IS the doer's access mode (modeByOwnerAndAccess →
GetDoerRepoPermission, upstream `repo_permission.go:448-508`): any row reads,
write/admin rank write, admin ranks admin, collaborators never rank owner.
The git-HTTP gate, the UI viewer fallback, and the API visibility predicates
all ride the same predicate (zero call-site drift); `visibilityConditions`
gains the `collaboratorGrantCondition` EXISTS arm (AccessibleRepositoryCondition
arm 2) so `/repos/search` admits collaborated private repos. Both recorded
TODO(SPEC-0005) notes flipped; suites 151/151 (83/83 re-verified at landing).

### Infrastructure: the ws1009 chain and the composite gate

This window's defining infrastructure story. The full `apps/worker` vitest
suite cannot run green in one invocation, and the cause is upstream
infrastructure, not our tests: `@cloudflare/vitest-plugin`'s `fetchWarmModules`
answers each test-file runner with the **whole already-transformed import
graph as ONE WebSocket message** (every module twice — `url` and `id`
aliases — with the sourcemap inlined in the code string), and local workerd
enforces a 32 MiB inbound cap on that socket (measured boundary
33,309,508 B pass / 33,654,312 B die). As feature waves grew the common
graph, runner startup deaths exploded 17 → **204 of 258 files (79%)** across
two clean baseline runs at HEAD `9468587` — deterministic, always solo-green,
zero real regressions (`docs/testing/suite-stability.md`, `870ca6c`). The
chain that followed:

1. **Sizing** (`53141fb`, `docs/research/ws1009-graph-sizing.md`): the
   vitest fs-module cache stores byte-exactly what the pool ships, so the
   fatal message was measured per module — common core 321 modules / 44 MB
   wire, **sourcemaps 61.5% of the payload**.
2. **Plan A falsified by execution** (`add4b80`): the static-edge model
   predicted 0/259 deaths from de-static-ing the UI mount; implemented
   behavior-preserving with all gates green, the death count stayed 204. The
   mechanism discovered by trying it: `fetchWarmModules` BFS-walks
   `node.importedModules` with **dynamic edges included once executed** — the
   plugin's virtual `cloudflare:test` module imports `src/index`, so any
   lazily-mounted edge re-enters every later file's snapshot the moment any
   test executes a request through it. No within-ownership graph shape
   escapes this; the change was reverted at landing review.
3. **The standing verdict — ADR-0006** (`4b86214`,
   `docs/decisions/0006-full-suite-composite-gate.md`): "the suite is green"
   is the **composite gate**, `pnpm test:full` (`scripts/full-suite-gate.mjs`,
   `9b16913`). Why single-pass died, in one paragraph: a green single-pass
   `vitest run` proves nothing about suite health at this scale — it silently
   omits the ~79% of files whose runners died at startup (a dead file neither
   passes nor fails; `dangerouslyIgnoreUnhandledErrors` would flip exit to 0
   while they never run, and was rejected without a run). The gate runs
   phase 1 as one full run with exact per-file attribution (death signature
   from the text log, two documented vitest-5.0.5 JSON reporter traps,
   assertion failures fatal and never retried) and phase 2 as `--solo`
   adjudication — every death/timeout file re-runs in its OWN vitest process,
   structurally immune to ws1009 (a fresh process first-connects an EMPTY
   warm snapshot). Batch re-runs were measured non-convergent (169 → 138 →
   115 pending, never 0 — every batch re-ships the same ~cap-sized common
   core), so solo is not an optimization; it is the only mode that
   terminates. **Standing rule: plain `pnpm test` stays the fast local loop
   for a file or scope and is never cited as "full suite green"; CI/landing
   verdicts use `pnpm test:full` (~15–20 min wall; the death count stays
   visible in every `--baseline-json`).** CI wired (`ef3b2ba`): the checks
   job gates on `pnpm test:full` with evidence artifacts uploaded `always()`.
4. **The root fix — lever B** (`9e70af5` + `2534ca1`):
   `CF_TEST_STRIP_SOURCEMAPS=1` (an `enforce:"post"` empty-mappings transform)
   removes the sourcemap byte family from the warm payload — **ws1009 deaths
   204 → 0, single-pass green restored** (verified twice; −21.66 MB measured
   on a controlled A/B; payload −60.3%). `pnpm test:full` exports the var, so
   the standing gate runs strip-mode end to end — phase 1 is single-pass
   again (≈174 s), with `--solo` retained as the safety net for the residual
   heavy-closure contention class (hook timeouts, one file per run). ADR-0006's
   postscript records revisit trigger #1 as fired. Tradeoff: full-run failure
   frames lose original-position mapping (the gate solo-adjudicates them
   anyway).
5. **The upstream filing** (`640005b`): **cloudflare/workers-sdk#16515**
   filed 2026-10-27 against `@cloudflare/vitest-plugin`, re-verified against
   the latest plugin (1.4.8 + wrangler 4.153.0 + workerd 1.20261023.1) before
   filing — signature unchanged. The sanitized archival draft is
   `docs/research/ws1009-upstream-issue-draft.md`; mechanism history in
   `docs/research/workers-vitest-ws1009-issue.md`.

**Determinism debts the gate's assertion-fatal path caught en route** (each
fixed before GO, per the RD20 paste 2): wave8's stale delete-form pin
(`4b86214`); mirror/sync's delivery-id floors scoping §2.7 reads to their own
sync — the stale "no queue consumer" assumption class (`c50fb52`); the
first-push settle drained before D1 legs — flake #3, the gate's third catch
(`82637d8`); the webhooks push delivery race settled-then-asserted — the one
real flake in the stability ledger, fixed pre-gate (`3a9b311`).

**Entry-docs freshness pass** (`9b7118f`): README re-measured to the
post-endgame reality; AGENTS Commands gains `test:full`.

---

## 2. Production verification

Four deploy windows shipped this session (evidence verbatim in
`docs/design/p0-evidence.md`; the detached-clean-worktree methodology
continues — `gitea/` pristine at pin `fc4936884584` throughout).

### Deploy lineage (continuing v1.1 §2's table)

| Version | When (UTC) | Tree | What it carried |
|---|---|---|---|
| **REDEPLOY17** `b928537a` | 2026-10-26 12:04 | `7cd1ce9` clean | the post-REDEPLOY16 mass, 4 commits: the toolkit's generic `--force-red` knob (`ee88c1b`, first production rehearsals), the attachments credential walk (`7cd1ce9`, token-first + session-cookie fall-through — REDEPLOY16's session-404 finding closed). Gates: typecheck 0, `check:api` PASS 490/298, `check:contract` PASS sha `529a3314…`; vitest **3544 passed / 0 failed, zero adjudications**; smoke 6/0/1; ledger 33/33; 7 batteries green (evidence `96cb9d4`) |
| **REDEPLOY18** `a842cfd8` → `abfbf291` | 2026-10-26 13:01 / 13:15 | `52a1f52` → `981c098` | tree-view's first production window + repo-scoped projects (`ae32b1a`, re-GO carried) — and **THE ?raw INCIDENT**: the GO deploy 500'd EVERY tree-view envelope for ~14 min. Root cause: vite's `?raw` returns the raw string (976 ui tests green) while wrangler's esbuild ignores the query on `.json` — its built-in loader returns the PARSED object and `JSON.parse(object)` threw per request; fix `**/*.json?raw` Text rule (`981c098`); `4ed30cc` never deployed (its bundle failed at the loader). Lesson recorded in the stanza comment: vite-native affordances are invisible to wrangler's esbuild. Also proven twice: main-tree dry-runs are non-authoritative — the proper-install worktree is the standard (evidence `baf28bb`) |
| **REDEPLOY19** `35e43cef` | 2026-10-26 late | `e39adad` clean | the closures window: payload stubs + parent read-gate (`3fcbe1a`), full repo GET payload (`a55a725`), renamed-fork fork-edge first resolver (`9ecb3e5`), search filters (`e39adad`), the index window (`67adfb7` — blob-excerpt stage-3 + its wiki twin, lastcommit, fetch-attrs flip). Carried-OPENs ledger EMPTY and production-proved (fragments 34/34, writer forms, renamed-fork edge). The **ws1009 class reappeared under load with the true 1009 signature** — the composite+solo adjudication standard was born here. NEW findings: migrate-201 born body rendering `mirror:false` + a LATENT lastcommit trailing-slash 404 — both fixed by `8a1a03f` in the next cargo (evidence `157ae60`) |
| **REDEPLOY20** `c4e8a373` → wrap `d18e6002` | 2026-10-27 | `a486853` → GO `50479cb` | the index window + deferred-matrix polish (126 commits since the RD19 base; pre-deploy evidence at `03f9e82`, `src/ui` 997/997). Paste 1: **Bug #19 found live and fixed in-flight** (below); **Bug #20 verdict reversed** (below). Paste 2, FINAL — the WRAP: GO `50479cb` → version `d18e6002`; **the standing composite gate PASSED at GO** (phase-1 full run 58 ran / 47 pass / 202 ws1009 deaths / 0 assertion + `--solo` adjudication 213 files, 0 fails; 13.7 min wall); **migrations 0033+0034 applied remote**; healthz 200 @3.0 s cold; **9 batteries** (window2-mounts 22/22 post-fix; window3-mounts — the `7b10786` 25-check battery — green on its first mounted run; mirror 8/8; registry 21/21; forkpr 8/8); two live findings folded back (probe budgets 20s→60s `1e489e3`; the wiki-raw 304's Cache-Control pinned to deployed truth `ba820b6`); force-red ×2 rehearsed post-fix (clean red, tails swept, zero left_behind) |

### The two live bug verdicts (RD20)

- **Bug #19 — REAL, production-only, fixed in-flight** (`a486853`): UI HTML
  responses carried NO `Cache-Control`, and the workers.dev edge
  heuristically cached per-viewer pages — observed live as a stale secrets
  row list for the creating browser (60 s and 5 min reloads rendered the row
  MISSING while the row sat committed in the primary; `no-cache` rendered it
  instantly). Every local gate was blind to it by construction. Fix: the
  upstream-parity zero-option middleware (`max-age=0, private,
  must-revalidate` on every UI HTML response). window2-mounts went 22/22
  once post-fix. Two related tails: the probe budgets raised to 60 s
  (`1e489e3` — heavy flows legitimately exceed 20 s on a fresh deployment;
  every "timeout" had left its repo server-side) and the wiki-raw 304's
  blanket Cache-Control pinned as deployed truth (`ba820b6`).
- **Bug #20 — VERDICT REVERSED: probe case bug, the write path exonerated**
  (`8a8d35f` + `7b95839`): the window2 battery minted lowercase-hex secret
  names while the service stores `normalizedName` (`strings.ToUpper` at
  insert AND lookup — upstream `InsertEncryptedSecret`, secrets.go:31) and
  the page renders the stored spelling: the row was on the page from t+0 as
  `W2SEC_<UPPER>`, and the case-sensitive grep hunted the lowercase mint.
  Cross-evidence: the failure tail's by-name API DELETE returned 204 on every
  red run (the row existed); D1 read replication is disabled (a stale read
  was never possible). Fix in the probe (uppercase mints + normalization on
  both sides + a pinning test); **no worker change — no redeploy needed**.
  Two dispatched diagnostic agents independently converged on the same root
  cause.

### What production proved this window

- Deploy gates at every GO tree: `pnpm typecheck` 0 errors; `check:api` PASS
  (490 ops / 298 paths, tier-1 78/78 paths, 129/129 ops); `check:contract`
  PASS (sha256 `529a3314…` verbatim, identical across the whole lineage).
- Migration ledger: 33/33 "No migrations to apply" through RD19; the RD20
  wrap applied **0033 + 0034 remote** — the window's only schema change.
- The toolkit ran every window; its arc completed this session (force-red
  knob `ee88c1b` → self-sweeping batteries `7d4c19a` → the window2-mounts
  battery `684f834` → window3-mounts `7b10786` → budgets/wrap fixes
  `1e489e3`/`ba820b6`/`50479cb`), with per-battery forced-red rehearsals
  proven in production (RD17, RD20 wrap).
- Cleanup discipline held: the RD20 wrap's one audit fail was the run PAT
  itself, deleted at wrap close by verified id (the paragraph in paste 2 is
  the record; standing bootstrap = 1).

---

## 3. Compatibility notes

### New migrations (this window)

| Migration | Content | Commit | Remote |
|---|---|---|---|
| 0033 `sleepy_mandrill` | `issue_content_history` (+3 indexes) | `cced424` | RD20 wrap ✅ |
| 0034 `happy_nemesis` | `user_settings.email_notifications_preference`, `.actions_email_notifications_preference` | `bf69f6c` | RD20 wrap ✅ |

Schema stands at **65 tables** (64 at v1.1's close + `issue_content_history`;
0034 is column-only). New SPECs this window: `specs/issue-content-history.md`,
`specs/user-notification-settings.md` (both SPEC-first, landing with their
migrations).

### Declared-operation count: unchanged at 490

The window's check-openapi runs (tick-12 `b12bd95`, RD20 pre-deploy and GO
gates) all read **490 ops / 298 paths** — the pre-Actions/packages ceiling
holds, 64 remaining ops all FEATURE-ABSENT (Actions 54 + package registry 10,
per `docs/compat/api-remaining-inventory.md`).

### UI parity ticks (the cut point's tick-6 → tick-15)

tick-6 60/3/50+1 (v1.1's close, `7a5861e`) → tick-7 61/3/48+2 (`bff7fdc`)
→ tick-8 63/3/46+2 (`075f916`) → tick-9 65/3/47 zero-in-flight (`f6ce45f`)
→ tick-10 65/4/46 (`c95d44d`) → tick-11 88/7/20 (the stage-1 window
accounted, `58ec303`) → **tick-12 91/5/20, board EMPTY** (`b12bd95`) → tick-13 91/5/20,
zero flips (`69068ac`) → tick-14 91/5/20, zero flips (`19d15a1`) →
**tick-15 92/4/20** (`ea6a49d` — the purge-page POST claims the A
trio row's one unclaimed member; the first headline move since the
board emptied). Counts
are programmatic, not eyeballed (the tick-5 methodology carried forward).

---

## 4. Known limitations (honest list)

- **64 FEATURE-ABSENT operations**, unchanged — the Gitea Actions runtime
  (54 ops) and the package registry (10 ops), each demand-gated on its own
  SPEC (`docs/compat/api-remaining-inventory.md`). Everything declarable
  short of them is declared.
- **The UI remainder is structural, not dispatchable** (tick-12): 5 PARTIAL /
  20 ABSENT rows are needs-API-first, FEATURE-ABSENT-gated, or no-RPC-gated;
  the survey's Recommendation section enumerates them row-class. The
  `.../raw` + `.../media` web shapes stay PARTIAL-by-divergence (our SSR
  emits tier-1 API raw links), closed opportunistically.
- **ws1009 residuals**: strip-mode trades original-position failure-frame
  mapping for a fitting payload (the gate solo-adjudicates those frames);
  the upstream chunked-warm-modules fix remains desirable (ADR-0006 revisit
  trigger #2) and is now FILED (cloudflare/workers-sdk#16515); the strip era
  grows a parallel fs-cache tree (the one-time `rm -rf` reclaim note in
  ADR-0006's postscript); the strip transform is env-gated, so plain
  `pnpm test` and solo runs still carry full sourcemaps and can still hit
  the cap on very large graphs solo (solo first-connects empty, so deaths
  cannot occur — only the shared-server full run is protected by the strip).
- **Not yet upstream-fixed**: the RD19 open issue on the vitest-pool frame
  cap is superseded by the filed issue (the plugin-side frame is the
  mechanism; #16515 carries the repro).
- Carried unchanged from v1.1 §4: **Git over HTTPS only** (SSH structurally
  out on Workers, ADR-0001); the **`email_hash` table** absent
  (`/avatar/{hash}` resolves empty by design until a schema wave);
  **no `/assets` fallback target**.
- **One cleanup-audit footnote**: the RD20 wrap's audit read
  `personal_access_tokens = 2` because the run PAT (id 44) was still alive
  at audit time; it was deleted at wrap close — the paste-2 paragraph is the
  record, and the standing count is the bootstrap PAT only.

### Addendum — the post-cut polish window (appended 2026-10-27, wave-129)

These notes were cut at `640005b`; the polish window that followed landed
REAL fixes the body never carried, so **nothing in §4 was retired** —
re-checked line by line. The ws1009 residuals line above is correct as
written: lever B (`9e70af5` + `2534ca1`) landed before the cut, and the
filed issue (cloudflare/workers-sdk#16515, `640005b`) is the cut point
itself. The post-cut fixes, all inside LANDED surfaces (the survey
headline is unchanged at 91/5/20 — `docs/compat/ui-parity-survey.md`
tick-13): the compare page's nothingToCompare fold + AllowEmptyPr
(`2c240fa`), the org-members keyword arm's LIKE-cap 500 closed via
instr() (`943e1e9` — the same class is being swept across the
topics/issues keyword feeds, in flight at append time), the id-order
sort stand-ins' tiebreak (`69068ac`), and the a11y sweeps (`132fec0`,
`ec2dd70`, `dc7362c`, `967a5d4` — zero bare th left in real data
tables; the admin-orgs listing's settings pencil named). Two postures disclosed and
still open: the compare equal-tips across-ref POST completion (in
flight, sibling-owned — the landed `sameTip` refusal stands until it
lands) and the admin-monitor thead-less golden policy call
(`967a5d4`'s documented-skip).

**Appended still 2026-10-27 (tick-14, HEAD `19d15a1`) — the second
polish cluster, which RESOLVES both postures above.** The compare loop
closed (`589debd`): upstream's web POST is tips-blind (pull.go:1318 →
NewPullRequest unconditionally; the only control is the render gate),
so equal-tips across-ref pairs now CREATE — the 303 onto pulls/1 with
zero-diff semantics — and the refusal narrows to IsSameRef's
name-equality only (main...main keeps the 422 as the disclosed
divergence; the API string gate pinned 422 same-ref / 201 across-ref).
The admin-monitor thead-less policy call made structurally (`ff3b4fb`,
R6's definition-shape exemption): upstream renders key/value tables
thead-less BY DESIGN (stats.tmpl/dashboard.tmpl's label rows) and the
total structural test — ≥1 row, zero th, every row exactly two td —
classifies them with real data tables' protection unchanged; the
monitor stats+queue goldens landed in it and the cron golden + the
ROUTE_CLOCK test seam (`df348c8`) close the wallclock audit — the LAST
admin golden. The rest of the cluster: the repo settings options
page's full field set + exact-carry hardening (`88cbd17`/`bacccf6` —
the port-first mode's last documented module gap; `setRepoArchived`/
`setRepoTemplate` service arms), the branches settings default-branch
select (module `ce52935`, mount `21b91ce` with the GET branchOptions
pass + SetDefaultBranchPost, route arms `862e9b3` incl. the
silent-private fixture finding), the icon.tmpl glyph chain tree-wide
(`65d07b6` OrgRepoListItem + `cb1fb3f` the stars/watching rows — the
unconditional fallback repo glyph was an undocumented divergence
matrix-8 flagged), the notifications legacy `?q=` alias (`e91f075`),
and the LIKE→instr() class sweep (`c91f689` — 11 user-text sites + the
releases tag glob translated exactly, closing the raw-LIKE `%`/`_`
wildcard leak). Goldens reach **66** (the final HTML batch `86d2de7` +
the three .rss XML envelopes `abd512f`; `19d15a1` teaches
update-goldens the .rss enumeration), and matrix batches 6-8
(`b61a5e8`, `3b24651`, `48b5f26`) add 77 test-only characterization
arms. The survey headline is re-verified unchanged at 91/5/20
(programmatically) — `docs/compat/ui-parity-survey.md` tick-14.

**Appended 2026-10-28 (HEAD `ea6a49d`) — the third cluster, the
session's closing pass.** The matrix program ran its saturation
census first (`419bfb1`, `docs/testing/matrix-coverage-census.md`):
the deferred-arm denominator (the 25 non-LANDED survey rows,
classified needs-API-first / feature-gated / no-RPC-gated), the
numerator (260 committed test files, 5,175 `it(`-level arms at census
time), and the yield curve — zero real bugs across the last 159
committed arms vs ~1 per 65 at tick-11 — verdict: **ONE more batch,
then SATURATED**. Batches 9-10 landed in the same window (`3d8b941`
31 arms, `97a638b` 28), batch 1 (`55b982b`) was recovered complete
after its agent died silent, and batch 14 executed the census's gap
list (`cee057b`: the milestone sidebar link + its stale no-page notes
flipped with `ca4eb58` provenance, the 4-module degradation-note
sweep, the four absence-pin arms, the issue-detail golden
re-baselined) beside batches 11-13 (`ac3f92d` 29, `8d48a18` 44,
`ac38040` 14) — batches 1-14 total ~360 arms by their own subjects
(the RD21 evidence's tally). The census's two new-surface S tails
landed committed-UNMOUNTED (`29b67cf`: the `comments/{id}/attachments`
JSON fragment + the `issues/new/choose` 303 — upstream's chooser IS
the redirect when no template pipeline exists; the mounts ride a
future index.ts window, the D rows stay ABSENT until then), and the
census's third tail — the notifications `purge-page` POST — MOUNTED
`ea6a49d` (NotificationPurgePagePost per notification.go:207-218; the
survey's A trio row flips LANDED — tick-15 re-walked the headline to
**92/4/20**, one PARTIAL retired). Between them: the push-mirror
lister's dead `??10` removed (`1bd7020`), `SeedFile.mode` + the
mode-change arms (`ad7e654`, zero engine changes), the wiki view
golden's net a11y arm (`e1c41f3`), the contention wave's per-file 90s
budgets (`382e337`, 11 carriers, recovered from the dead agent), and
the GPG verify minute-boundary race guarded (`50880b2` — a REAL
time-bomb, not a load flake: the route's single-minute token dies
when the RSA sign + fetch crosses the boundary, observed 2-of-4 full
runs plus once solo; `avoidMinuteBoundary` gives the chain ≥55 s of
slack; zero product change). **REDEPLOY21** shipped the polish cargo
(GO `cee057b` → version `fe6bcca1`, evidence `75bd33e`): the gate ran
**two perfect strip-mode single-passes at 261 files / 5,831 tests /
0 failed** — the contention class formally RETIRED (the budgets + the
GPG guard were its last two real members; the epilogue in
`docs/testing/suite-stability.md`); 9 batteries green (mirror 8/8 on
the warm rerun — the cold-consumer first-sync latency, the RD20 cold
class), force-red ×2 clean, and the PAT-mint plaintext incident
disclosed (the leaked token was never inserted into D1 — zero
server-side exposure; the `node -e` mint is the pattern of record).
`ea6a49d` landed AFTER that deploy and rides the NEXT one. Upstream,
the filed ws1009 issue (cloudflare/workers-sdk#16515) drew a community
PR — **#16523** proposes the chunked warm-module-frames fix (16 MiB
frame budget, ordered envelopes, reassembly before devalue parse);
bot-closed under the unvouched-collaborator policy 2026-10-27,
pending maintainer triage — ADR-0006's revisit trigger #2 stays
armed. §4 re-check: no line retired — the ws1009 residuals line and
the 64-op FEATURE-ABSENT ceiling stand as written (no API work in
this cluster). Re-measured at `ea6a49d` (not copied): goldens **67**
in `src/ui/__tests__/goldens/` (64 HTML + 3 RSS, plus the session
`login.html`), committed test files **262**, **5,209** `it(`/`test(`
call sites (the census method).

**Appended 2026-10-28 (HEAD `bd6d257`) — the fourth addendum: the wave-130
parity-review wave and its fix wave.** REDEPLOY22 shipped the third cluster's
last cargo (GO `5f3c26f` → version `73158aa8`, evidence `7bec99e`: healthz
200 @2.2 s, no migrations, gate single-pass 261 files / 5,831 tests / 0
failed, battery 108/2 — the mirror cold-start settle green on the warm
rerun plus the live run-PAT audit item deleted at wrap) and **coincided with
the wave-130 parity-review kickoff**: five parallel reviewers (auth, api,
engine, services, git-http) swept the landed surface for upstream-parity
defects. Their verdicts drove the fix wave that followed — **15 commits,
`28df818` → `bd6d257`, landing 30 findings with 7 deliberate keeps** (each
kept item verified against upstream source and documented, e.g. migrate's
422, the POST-issues label/milestone validation vs upstream's silent drop,
the webhook `skipped`/`failed` → `is_delivered=false` mapping, the token
name>255 client-error arm). The full scoreboard — the five reviews' summary
tables, the 30-landed list with commit hashes, the 7 keeps with rationales,
and the credits — is `docs/reviews/wave-130-parity-review.md`. The gold the
reviews caught, one line each: **PR-sync** (`140fc0b` — pushes never moved
`refs/pull/N/head`; merges after a second push merged the WRONG tree),
**tag-only deletion** (`0626ced` — pushing only a tag to a nonexistent repo
deleted the just-created repo row), **org revocation** (`84da8f8` — removing
a member left their team grants live through the real gate), the **session
cookie** (`28df818` — visiting `/login` signed-in after 24 h silently logged
the user out), and the **GPG time-bomb** (`50880b2` — the verify chain's
single-minute token, guarded by the verdict runs). Schema grew by one
additive migration — **0035 `spooky_galactus`** (`sessions.remember`, the
login's persistence decision surviving rotations per upstream
`auth.go:127`'s posture) — which rides the NEXT deploy window (REDEPLOY22
carried none). The SPEC ledger caught up in the same pass: SPEC-0010
§2.3/§2.4 amended to say what rotation IS (the persisted remember decision +
the full cookie directive at every rotation site; the old "always
session-scope" implication retired), SPEC-0002 §4.6 gains the auth review's
(b) items #13–15 (documented divergences), and SPEC-0004 §2.4 records the
api review's S2 policy decision as an intentional as-built divergence. §4
re-check: no line retired — the 64-op FEATURE-ABSENT ceiling stands (the
wave touched zero undeclared surface; `check-openapi` PASS per commit), the
UI remainder is unchanged (fix wave, no survey flips; tick-15's 92/4/20
headline stands), and the ws1009 residuals stand as written — the gate ran
clean at REDEPLOY22's tree, and the fix wave's own landing gate surfaced
exactly three ripples (`bd6d257`: the migrate format's two stale pins + the
date-rolled admin golden).

**Appended 2026-10-28 (HEAD `7c3b7c4`) — the fifth addendum: the wave-130
ledger lands, RD23 ships the fix wave, the perf wave opens.** The five-review
sweep (git-http / services / api / engine / auth) closed with its scoreboard
committed (`6165474`): **37 SUSPECT findings, resolved as 30 landed (L1–L30,
each with its commit) + 7 deliberate keeps (K1–K7, each verified against
upstream source and documented)** — `docs/reviews/wave-130-parity-review.md`
is the authority for every number in this paragraph, quoted not re-counted.
The fix wave's gold, one line each per the scoreboard's ledger: **PR head-ref
sync** (`140fc0b` — pushes move `refs/pull/N/head` through a standalone
post-commit CAS off the onPush fan-out; merges stop operating on stale code
after a second push), **resolveNamedRef strictness** (`5539eb9` — the
existence-oracle `fallbackDefault` param deleted outright after the
8-consumer verdict table showed all strict, zero legitimate defaults), **the
org revoke team-grant sweep** (`84da8f8` — `removeMember` revokes team grants
behind the last-owner guard; `deleteOrg` sweeps the team tables child-first),
**the issue delete cascade sweep** (`d5b111d` — upstream's full DeleteBeans
set, all seven tier-2 tables + their R2 objects, storage-first and
retryable), **session rotation with the remember-cookie re-set** (`28df818` —
all three rotation sites wrap through `sessionSetCookie` with the row's
remember bit, the persistence decision carried by migration 0035), **the
user-visibility ladder** (`3f48b74` — the upstream-exact
`IsUserVisibleToViewer` reduction, limited → ANY signed-in; invisible users
fake-404 byte-identical to a miss), **sudo mounted public-only** (`32eaa73` —
upstream's own tree-wrap mounted cite-for-cite with the public-only family
wired the same way, never blanket-applied), and the **GPG verify
minute-boundary guard** (`50880b2` — ≥55 s of slack under the RSA-sign chain;
found by the review wave's own verdict runs). The keeps stand documented (K1
in SPEC-0004 §2.4, K3/K4/K5 in SPEC-0002 §4.6 #13–15, K2 in `3d5c9d0`, K6/K7
in `32eaa73`'s placement table).

**RD23 shipped the fix wave.** Migration **0035 `spooky_galactus`** applied
remote — the fourth addendum's "rides the NEXT deploy window" honored, and
the window's only schema change. The probe toolkit gained its **10th battery,
fixwave-parity** (`29e3a43`): 22 checks over the fix wave's live shapes
(PR-sync head movement + mergeable re-resolve, merged-412 verbatim,
strict-ghost 404, tag-only push-create survival, the visibility ladder, sudo
impersonate/403, the org revoke with its `fw-org-member-preaccess`
discriminator arm, the session-rotation directive + adopted-cookie
round-trip via the toolkit's first D1-write helper), with the README's
battery list brought current for all 10 (`f963ef8`). Its live smoke against
the standing deploy read **20/1** — every fix-wave arm already green, the one
red being the pending org-grant deploy (quoted from `29e3a43`). Per the
orchestrator's deploy record — its evidence block had not landed at append
time, so these are quoted as given, not re-measured — RD23 deployed worker
version **`a54c6adb`** with the battery at **112 passed / 1**, the 1 being
the run-PAT audit item deleted at wrap close (the RD21/RD22 pattern).

**ws1009: filed upstream, watched, not ours.** The filed issue
(cloudflare/workers-sdk#16515, `640005b` — the v1.2 cut point itself) carries
the warm-payload mechanism our strip lever routed around (`9e70af5` +
`2534ca1`: sourcemap bytes stripped from the warm modules — deaths
**204 → 0**, **−21.66 MB**, both quoted from §1 above); the community
**PR #16523** proposes the upstream chunked-warm-module-frames fix (16 MiB
frame budget, ordered envelopes, reassembly before parse) — bot-closed under
the unvouched-collaborator policy 2026-10-27, pending maintainer triage;
ADR-0006's revisit trigger #2 stays armed.

**The perf wave opens** (`29e3a43` → `7c3b7c4`, this addendum's tree delta):
migration **0036 `fantastic_whirlwind`** (`b04a465`) lays **10 hot-path
indexes** — the labels repo/org pair, reactions' issue/comment/release
composite, the issues list page's filter+order composite, milestones,
repositories owner_id, the two poster heatmap composites (issues' is
COVERING, index-only), the action repo-feed order, `issue_subscriptions`
(issue) — upstream-matched where an upstream index exists, divergences
documented at each, with the **always-on rows_read witness** in `bench-d1`:
**reactions target 250 → 6, the issues list page 480 → 30, subscriptions
200 → 3** (quoted from `b04a465`; EXPLAIN asserts the plan per shape).
Matrix batch fifteen (`7c3b7c47`) pinned the fix wave's route-level seams
from the user side — **133/133** across the four suites (PR-head sync through
the real gate composition, the sudo seam from both sides, the org revoke's UI
half; the user-visibility UI half and the compare-empty page arm verified
already pinned, no gap).

**PENDING — the orchestrator finalizes these lines after the deploy
freezes:** migration **0037** (the P2 sweep + the verified-dead drops; not
yet in tree) and **RD24** (payload **0036 + 0037**; verdict arm
**`fw-org-member-preaccess`** — the fixwave battery's post-deploy
discriminator, `scripts/deploy-probes.mjs`). §4 re-check: no line retired —
0036 is index-only (the 65-table count stands; 0036 and 0037 ride RD24),
`check-openapi` PASS at `b04a465` keeps the 64-op FEATURE-ABSENT ceiling
intact, and the ws1009 residuals line stands as written.

**Appended 2026-10-28 (HEAD `98eb3f6`) — the sixth addendum: the post-ledger
mega-window, four waves deep.** The fifth addendum pre-drafted its wave
before the deploy froze; the window it pointed at then landed whole — **56
commits, `af1a14a` → `98eb3f6`, 2026-10-28 10:03 – 13:27 +0800** (the delta
after the fifth addendum's own commit `da78825`). Every hash below was
re-verified against `git log` at append time; every number is quoted from
its recording doc or commit, never re-measured.

**The perf wave.** The hot-path query-shape audit (`e85dc1b`,
`docs/research/query-shape-audit.md` — static and read-only, every claim
citing `file:line`) ranked **10 N+1 loops** plus the re-fetch/over-fetch
families into a 15-row fix queue, and the wave it seeded landed the same
day, per the audit's dated Landing Status table (added `7be89c4`): the
**S-grade collapse** `c614daa` (A1's label batch, A4/B2's dead-batch wire,
A10's parallel tree walks); the **M-grade list batching** `fbd0826` (A2/A3/
A6/B1 — page-independent render contexts, the two heaviest API lists'
**92-242 roundtrips → 8-10**); the **A5 timeline** `42a07cf` (the mixed
stream page-batched, **21 → 7 at seed**); **tier-2 preload adoption**
`57794e7` (**13 more list surfaces** page-independent — both A7 comment
lists); the **A8 feeds** `30284a6` (R+C per-row reads → two batched arms);
the **A9 grant folding** `4dc7f54` (the fork-head grant fan folds into one
batched resolution, **11 → 4 at four grant-bearing heads**; the single-call
loop stays by design per the audit's caveat); and the **C2 + xml-C2 pair**
(`6ad06be`, `f23fe6a` — the activity page's issue-title over-read and its
feed-XML twin both consolidate onto the service, **rows_read 45 → 4,
twice**). A10's L half stays open (below). Underneath it, migration **0036
`fantastic_whirlwind`** (`b04a465`) laid **10 hot-path indexes** with the
always-on **rows_read witness** in `bench-d1`: **reactions 250 → 6, the
issues list page 480 → 30, subscriptions 200 → 3** (quoted from `b04a465`;
EXPLAIN asserts the plan per shape). Migration **0037 `smart_blizzard`**
(`7dc607f` — the fifth addendum's PENDING, now in tree) completed the RD24
payload: **8 adds, 9 verified-dead drops**, and the wave's key finding —
**8 of 15 drop candidates were VETOED by the new 15-shape battery** (the
SQLite-prefers-the-prefix-twin redundancy analysis was empirically wrong:
SQLite chose the narrow scalar and switched plans after the drop, failing
the plans-UNCHANGED proof; all 8 stay with keep-notes; the dropped
`deploy_keys_token_hash` re-adds with the git-HTTP deploy-token arm). The
durable method record and the wave ledger landed together (`af1a14a`:
`docs/research/d1-index-engineering.md`,
`docs/reviews/wave-131-landing-ledger.md` — the latter also reconciled
RD23's battery arithmetic EXACTLY: nine standing batteries = 113 checks =
112 passed + 1 audit item, and `a54c6adb` confirmed a deploy-version
string, not a git object).

**The engine wave.** **D3, the failed-publish lease fix** (`6545edd` — the
state-transition table's divergence ledger found the gap): graceful publish
error exits fell through the unconditional finally-deleteLease, destroying
the expired-lease sweeper's only pointer to written-but-unpublished bytes;
the published-flag guard now parks a failed round as compaction_in_flight
exactly like a crashed holder, and the 10-min TTL sweep — not the round —
converges the orphan (§5.3 checks 8 → 10, mutation-tested; SPEC-0011
amended, the doc's D3 entry flipped FIXED). **PushEvent.origin**
(`7079b59`): origin derived AT the emission site from receivePack's live
request (http/s only; any parse failure degrades to undefined because the
call site runs POST-finalize on an already-applied push that must never
500) — and the new check found a REAL engine bug in the same block: the
wrapper was `waitUntil(Promise.resolve(onPush(...)))`, which evaluates the
hook BEFORE the promise wrap, so a SYNCHRONOUS throw escaped and, via
receivePack's outer catch, turned an already-applied push into a 500,
violating the hook's documented never-fail contract; now
`Promise.resolve().then(() => onPush(...))` (mutation-witnessed
500-vs-200). **The husk fix** (`ed0efed`) with its CORRECTED root cause —
NOT an engine cursor leak: on the pinned miniflare-5-beta/workerd, EVERY
`DROP TABLE` against a sqlite-DO database created by a PREVIOUS runtime
session fails SQLITE_LOCKED, deterministically and forever; healthy cells
just live and die inside one dev session, and purged husks are what LATER
sessions' cleanups hit. The semantic fix treats a content-less cell
(schema refused AND no refs + pack rows + loose objects) as no-op success
200 with only idempotent side effects, never reaching the DROP;
content-bearing cells still wipe (in-session DDL works) — and the runtime
defect OUTLIVES the fix for them locally (the first DELETE after a dev
restart still 500s; queue retries + the new DLQ backstop; NOTICE records
it). The durable record is
`docs/research/workerd-ddl-cross-session-locked.md` (`10d5d44` — the
ws1009 house style: versions verified against the lockfile, a standalone
~80-line miniflare-only repro syntax-checked but NOT executed, a 7-item
could-not-verify ledger; **filing awaits the user's nod**, the #16515
pattern). **A10-L** — the batched `listTreeCommits` engine RPC, the audit's
one open L-half (the repo home's worst serial wall-clock fan) — is IN
FLIGHT at append time.

**The compatibility wave.** The **wiki family wired** (`466092c`): three
write triggers (created/edited/deleted) fire upstream-faithful wiki
deliveries through one service funnel (API routes and the UI writer emit
identically) — **21/26 fully emitted, not-emitted-with-feature back to
ZERO** (the bucket wave-api-wiki's silent landing had re-occupied). The
**emissions completion** landed RECOVERED (`9ce2ffb`, provenance disclosed
in the commit: the unit died at the quota reset mid-flight WITHOUT
reporting; the orchestrator recovered the landing — tree verified coherent,
tsc 0 across the workspace, 167/167 own-eyes across the five affected
suites, the diff reviewed hunk-by-hunk): the issue-DELETE route now fires
the action=deleted dual payloads (issue + PR arms), the branch-delete
PR-close cascade's DEFERRED webhook fires exactly once per transitioned
close, and the APP_URL/origin threading folds — the coverage doc caught up
(`01c00bb`) at **23/26 fully emitted (88%), zero partial rows**, the
remaining-work list down to housekeeping. That housekeeping then landed:
the **fork delivery assertion + the full diff_hunk derivation**
(`4e60408` — the coverage audit's last two tails: fork's forkee = the
SOURCE repo asserted over webhook_deliveries rows, and `comments.patch`
now captured at creation via upstream's cut + synthetic-fallback shape,
with its documented limits), then **PATCH-assignee for issues**
(`b433fb1` — the stale migration-0012-era rationale retired; the write
core moved VERBATIM from pulls.ts onto the service seam, the emission
inverted into an onAssignee callback preserving upstream's post-tx order)
and the **t2 assignee dedupe** (`98eb3f6`, this addendum's HEAD — 256
private tier-2 lines onto that seam carrying BOTH upstream shapes
verbatim, routes 1846 → 1589, byte-equal emissions witnessed by the
unmodified suites).

**The release wave.** Going public: **LICENSE (MIT) + the root NOTICE**
(`a5c4b01`); the **example-file graduation** (`0f73ad4` + `f72c697` — the
AGENTS.md graduation trigger fired: `wrangler.jsonc` untracked and
gitignored, `wrangler.jsonc.example` the committed template, all 7 CI jobs
restore from it after checkout, the official Deploy-to-Cloudflare button
mounted with the explicit self-host guarantee stated). The publish gate's
two preconditions: the **pre-publish secret scan PUBLIC-SAFE** (`d218b80` —
full object-database scan, 7419 objects / 2652 blobs, ~100 MB, **zero
secrets in 720 commits**, both known incidents verified clean) and the
**fresh-clone proof FRESH-CLONE-OK** (`7781596`) — whose arbitration found
the scan's placeholder claim WRONG (pre-graduation history has carried the
real database_id since `ab61b5a`; the placeholder comment lied from day
one) and made the **acceptance decision: ACCEPTED** — the id is inert per
AGENTS.md doctrine, and a scrub would invalidate every hash citation in
the docs; the documentation IS the provenance (rationale appended to
`docs/reviews/fresh-clone-proof-2026-10-28.md`). Onboarding: the
**first-run bootstrap** (`515a594` — the zero-user admin install window,
the empty-table check living IN the INSERT so concurrent first-submissions
resolve to exactly one admin, plus the ALLOW_SIGNUP gate defaulting to the
closed self-host posture; mounted `df1e362`) and **APP_URL automation**
(`57d3382` — the request-origin fallback + the Deploy-button bindings
metadata) completed by **PushEvent.origin consumption** (`800b180` — the
appOrigin chain **var > event > request > default**, pinned at unit,
emission, and adapter levels). Demo ops (SPEC-0014): **M0's repo-tasks
DLQ** complete (`385f768` the handler half, `de486aa` config + dispatch —
with the deploy note that the repo-tasks-dlq QUEUE must exist at deploy
time) and **M1 mounted** (`5c59f1f` the DEMO_MODE gate + the 72 h sweep,
invariant-first; `15e2b62` the scheduled dispatcher + the dlq kindLabel
fold — M1 COMPLETE end-to-end); **M2 (banner + quotas) is in flight**. The
**three harness hardenings** closed the e2e sweep's open issues: the
mirror harness (`4073027` — checked DELETEs, the run interlock, the
stale-state sweep, 93/0 three consecutive — and its guard then CAUGHT the
husk class live, feeding the engine wave), ported to the **lfs + engine**
harnesses (`37ec111` — abort loudly instead of poisoning silently; the
engine harness deliberately skips the cell-file sweep, never owning its
server). Bookkeeping around the waves: the RD23 evidence block drafted
from the records + the RD24 fill-in template (`f9a63ec`), the audit's
landing ledger + the submodule-flake note (`7be89c4`), the mirror sweep's
resolution note (`23d5ab5`), the SPEC-ledger syncs (`aabb6ba`, `4556669`,
`5c1b497`, `68b622b`, `b3911c4`, `322f666`), the M3 state-transition table
regenerated from code (`321688b`), the mirror HEAD-adoption fix
(`071f10b`), the branch-protection battery + its addressability fix
(`e9f37f2` + `bd59bc4`), the slash tag names (`af92937`), and the
dependency freshness census (`4d039cb`).

**PENDING — the orchestrator finalizes these after the deploy freezes:**
**RD24 itself** — its evidence block exists as the fill-in template
(`f9a63ec`): the deploy version, healthz, **migrations 0036 +
0037 applied remote** (the window's only schema change, both index-only —
the 65-table count stands), the **battery verdicts** including the
branch-protection battery — the toolkit's **11th, 18 arms** (`e9f37f2`'s
17 checks + `bd59bc4`'s slash-glob arm) joining the standing census — and
**THE DEPLOY DISCRIMINATOR `fw-org-member-preaccess` GREEN**: the
fixwave-parity arm that read red in RD23's standing smoke (the 20/1) is
expected green at RD24's formal run, and the block must state which run
FIRST recorded it green (the wave-131 ledger's flagged §6 tension), plus
the full-gate line at the final tree. **A10-L** and **M2** finalize when
their units land. §4 re-check: no line retired — 0036/0037 are index-only
(the 65-table count stands), `check:api` PASS at the HEAD (`98eb3f6`:
78/78 + 129/129) keeps the 64-op FEATURE-ABSENT ceiling intact, and the
ws1009 residuals line stands as written.

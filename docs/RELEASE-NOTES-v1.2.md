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

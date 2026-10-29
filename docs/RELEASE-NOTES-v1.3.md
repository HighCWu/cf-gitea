# cf-gitea v1.3 — Release Notes

Snapshot 2026-10-29, HEAD `e5e1432` — the v1.3 wave, cut MID-FLIGHT: 28
commits, `d68ad62`→`e5e1432`, all on 2026-10-29 (06:53 – 09:41 +0800). The
window opened with the UI gap census that classified and briefed every
remaining survey row, landed the engine read family at the boundary (grep
with a budgeted NFA, `activityStats`, `contributorStats`, plus the blame
RPC), closed ten census rows in one combined UI landing, shipped the
audit-events model with retention (migration 0038), and ratified four SPECs
(0015–0018). Five units are in the working tree at cut time and are named as
such everywhere below — nothing in flight is counted as landed. Every number
is quoted from the commit or doc that recorded it; nothing was re-measured
for these notes.

**Cut point.** The v1.2 notes close at the seventh addendum (`8b9be25`, the
RD25 record). This window's first three commits are that release's last
breath — the RD25 postcheck (`d68ad62`, RESTING-STATE-COHERENT), the
push_bytes determinism pin (`5f7caed`), and the postcheck's closable batch
(`173deab`); the census (`b5fd430`) then opened this wave. Everything from
`d68ad62` to `e5e1432` is the delta these notes cover. Addenda will follow
as the in-flight units land and the next deploy window freezes — no deploy
shipped inside this slice yet, so everything here rides the next REDEPLOY.

---

## 1. What v1.3 is

The directive is the census's own: **upstream Gitea serves it → cf-gitea
serves it** (`docs/compat/ui-gap-census-2026-10-29.md`, `b5fd430`). The
survey tick-16 remainder — 22 non-landed rows (17 ABSENT + 5 PARTIAL of
116) — was classified, briefed, and ranked; this window then executed the
top of that board. The per-row landing ledger (row → closing commit, hashes
verified) is appended to the census itself; what follows is the wave view.

### The engine read family (SPEC-0015, accepted `5025476`)

Four capability verdicts with pin-verified upstream cites; §7's six open
questions ratified before any code. Three of the four RPCs and the audit
model landed the same morning:

- **M1 — `grep`** (`0644597`): modes exact/words/regexp over a budgeted tree
  walk; `words` is the per-line case-insensitive AND (git-verified), and
  `regexp` runs a step-counted NFA — linear simulation, because native
  backtracking cannot be budgeted in workerd, so catastrophic patterns
  answer linearly. Budgets: 2,000 files / 50 results (upstream's own silent
  cap, flagged in the commit) / 200k scan steps / 2M regexp expansions.
  Oracle `check-grep.mjs` 11/11 against real `git grep`; wired into CI's
  engine-check step (`2a7093d`, 21 checks).
- **M2a — `activityStats`** (`7a310b3`): period-switched first-parent fold
  (merges excluded), committer-time windows, per-author add/del via
  first-parent diffs, 10-minute TTL over `stats_cache`'s `act:<period>`
  namespace. Oracle 10/10 vs real git. The ratified
  `commitCountInAllBranches` cut is tripwire-pinned.
- **M2b — `contributorStats`** (`449400a`): the full-history per-week walk
  (merges excluded from the fold, counted as cap slots), Sunday-anchored
  Unix-ms buckets in each commit's recorded timezone, oldest-name
  precedence, no TTL (the SPEC's fixed-history immutability). Oracle 10/10;
  CI wiring carries 23 checks.
- **M4 — audit events + retention** (`5c8853c`): the `audit_event` D1 table
  (upstream `audit_event.go:22-38`'s shape, migration **0038
  `luxuriant_tempest`**), the `defineAction`/`renderMessage` registry with
  the upstream-verbatim `organization:*`/`repository:*` families,
  batch-composable `auditEventInsert`, slice-one instrumentation on repo/org
  create inside the existing D1 batches (a collision emits nothing — the
  invariant made structural), and 90-day retention as a fail-closed
  `AUDIT_RETENTION_DAYS`-gated producer on the hourly cron with the paged
  idempotent consumer arm in `handleRepoTasks`. 28/28 audit tests; 51/51
  purge/sweep/audit post-folds.
- **M3 — `scanLfsPointers`** is the family's one pending member (accepted
  in the SPEC, not yet at the boundary).
- Beside the SPEC, the **blame boundary RPC** landed (`aa1fb29`) — the DO's
  existing blame machinery exposed at the boundary with real-git oracles;
  it is the idiom every new RPC in the family followed.

### The combined UI wave (`77e8567` — ten census rows, one coherent tree)

Nine units landed together (composite 281/281; tree tsc and eslint both
zero): the **fork grammar** on compare (the full upstream
`ParseCompareRouterParam` — two-dot DirectComparison, head-side fork forms,
the writer gate flipped to pulls-read parity); the **blame page** (R08) over
the landed RPC; the **raw/media byte families** (R21/R22) with the
deprecated legacy-guess catch-all and LFS pointer resolution — `links.ts`
switched to upstream's web shapes, retiring the tier-1 API raw-link
divergence; **explore organizations** (R01); the **owner heatmap** web JSON
route + profile widget (R03); the **org issues/pulls/milestones inbox**
(R07, member-ladder scope + team arms); the **org dashboard** and the team
name carrier (R06/R19, the member-only 404-shell posture kept); the **admin
emails/hooks/badges/applications pages** (R18's implementable-now arms); the
**org settings applications tab** (R20's applications arm); and the shell's
**Activity tab** chrome + the repo-activity route wiring (R14). The folds
that came with it: the dispatcher's viewer grant on cross-repo feeds, the
global-inbox past-end pager record, the `EngineClient`
grep/activityStats wrappers (M1/M2a's landing halves), and the
`actUserCond` parenthesization the org-dashboard matrix caught; goldens
regenerated at the merged state under the T0 user-creation pin.

### The Activity page chain (`5f5e167` → `7a310b3` → `77e8567` → `c14359c`)

The repo pulse page landed counts-first (`5f5e167`), was wired with the
shell's Activity tab (`77e8567`), then upgraded to the engine (`c14359c`):
commitCount/authorCount switched to the M2a RPC's first-parent fold and the
numstat trio (changedFiles/additions/deletions) replaced the placeholder;
the all-parents `listLog` walk retired (~70 lines). The D1 issue/PR/release
lists stay — upstream derives those from SQL too. 13/13 with engine-seeded
fixtures; render/tree-view neighbors 53/53.

### The SPEC ledger: four ratified in one window

**SPEC-0015** accepted (`5025476`). **SPEC-0016 packages** and **SPEC-0017
commit-graph** drafted (`8dd664b` — 23 model types mapped to six D1 tables +
an R2 blob namespace; the SSR-SVG mechanism verdict with the in-DO lane
algorithm) then **accepted** (`0717de7` — fourteen open questions ratified:
two-pass blobs + global dedup + 512 MiB quota + sole-sweeper deletion;
host-the-JS + lane algorithm + hybrid pager + the v1 identity cut).
**SPEC-0018** accepted (`36d9b52`) — the admin (b) arms' verdicts: notices
BUILD (the DLQ emitter maps every fact upstream's emitters carry), config
BUILD as the read-only summary over wrangler vars/bindings with the
secret-hygiene rule, auths OMIT with the reasoned ledger (no login sources
exist; OAuth2 applications are clients, not sources).

### In flight at cut time (working tree, uncommitted — not counted anywhere)

The **repo search page** (R10's UI half — the grep RPC is landed), the
**settings audit-logs page** (R13's UI half — the model is landed), the
**activity charts pages** (R15's UI half — `contributorStats` is landed),
the **`graphData` RPC** (R09 — SPEC-0017 accepted), and **SPEC-0016 M1**
(the package registry's first milestone: routes, services, migration 0039).

---

## 2. Engineering notes — the coherence incident chain

The wave's first hours produced one incident class and the tool that closes
it; recorded here because it changed how commits are made, honestly and
briefly.

The HANDOFF retirement sweep (`8fd9961`) swept two mid-flight artifacts into
commits: the fork unit's compare-parser snapshot (its four typecheck error
classes masked locally by the unit's live-tree fixes — restored at
`75400b5`, call-sites joined at `a48d244`) and, worse, flushed
legitimately-landed router arms off the shared file — the committed tree
404'd the repo-activity route on clean checkout until `b61220b` restored
the committed router's coherence and grafted the missing arm. The standing
fix is **`scripts/verify-commit.mjs`** (`946e2c4`): the staged-state commit
guard verifies exactly what a pathspec commit would land (temp-index
plumbing + an isolated worktree running real tsc, never touching the working
tree or the real index), with a 20-check self-test matrix. It earned its
keep the day it shipped — its real tsc caught the eight fork-era handler
errors that both the pipe-masked worktree check and the vitest composite
had missed (the composite never typechecks across files). CI's eslint then
caught the guard's own header convention (`43a9b39`).

The same morning's determinism work, one line each: the golden harness's
user `created_at` pinned to T0 (`7ba1ed6` — the admin-users date cell was a
daily time-bomb that rotted at midnight); the bench's push_bytes cycle
asymmetry pinned (`5f7caed`) and clone wall/rate floors calibrated above
the measured 4.5× cross-runner noise band — 2,000 ms / 5 MiB/s, after four
CI runs on clone-path-identical code spread 589–2677 ms against a 783 ms
baseline and false-fired the percentage gate (`9db02ab`); the stats
fixtures' conflict-merge construction made content-independent (a CI
runner's git refused to start the merge, the catch swallowed it, and a
fixture commit landed single-parent — run 40800106017 — both fixtures now
build clean merges with MERGE_HEAD asserted, and contributor-stats' checked
in Carol week recomputed) plus the GPG verify tests' bounded
flip-conditioned retry (`e5e1432`); and the demo-sweep cron tripwires pinned
`AUDIT_RETENTION_DAYS` off in test envs so CI's example-restored config
cannot arm the M4 audit producer against the zero-D1 tripwire (`fbc5a7c` —
51/51 reproduced under the armed var; ADR-0005 D3 at test-env level).

---

## 3. Compatibility notes

### New migrations

| Migration | Content | Commit | Remote |
|---|---|---|---|
| 0038 `luxuriant_tempest` | `audit_event` (+5 indexes incl. the EXPLAIN-witnessed `(scope_type, scope_id, created_unix)` composite) | `5c8853c` | pending — rides the next deploy window |

Schema stands at **66 tables** (65 + `audit_event`). The in-flight SPEC-0016
M1 carries migration 0039 (uncommitted at cut time). No deploy shipped in
this slice, so 0038 is committed-but-not-yet-applied remote.

### Declared-operation count: unchanged at 490

The committed API router carries no packages routes — **490/554 operations
declared across 298 paths** stands at HEAD (`check:api` PASS; tier-1
terminal 78/78 paths, 129/129 ops). The count moves only when SPEC-0016's
M1 routes land (the 10-op package family).

### UI parity: the survey arithmetic

Tick-16's programmatic headline 94/5/17 moves to **103 LANDED / 2 PARTIAL /
11 ABSENT** of 116 with this window's nine whole-row flips (six ABSENT →
LANDED: R01/R03/R06/R07/R08/R14; three PARTIAL → LANDED: R19/R21/R22; R18
and R20 stay PARTIAL with their landed arms recorded in the census ledger).
The survey's next formal tick re-walks the tally programmatically; until
then the census's landing ledger is the row→commit authority.

---

## 4. Known limitations and the in-flight list

- **64 FEATURE-ABSENT operations**, unchanged at HEAD — Gitea Actions
  (54 ops, the SPEC-0012 demand gate) and the package registry (10 ops,
  SPEC-0016 accepted with M1 in flight).
- **Five units in flight**, named in §1: the repo search, settings
  audit-logs, and activity charts pages; the `graphData` RPC; SPEC-0016 M1.
  None is counted as landed anywhere in these notes or the README.
- **SPEC-0015 M3 (`scanLfsPointers`)** is the read family's one pending
  member; the settings/LFS page family (R11) waits on it.
- **R02/R05** (explore/user code search) stay gated on the indexer-class
  subsystem — the grep RPC deliberately does not open them (SPEC-0015
  out-of-scope).
- **No deploy this slice**: every commit above rides the next REDEPLOY
  window; migration 0038 applies remote then. The RD25 deployed-reality
  record in `docs/design/p0-evidence.md` remains the last production
  verdict.
- Carried unchanged from v1.2 §4: the ws1009 residuals (strip-mode trades
  original-position failure-frame mapping; the upstream chunked-frames fix
  remains desirable — ADR-0006's revisit trigger stays armed against
  cloudflare/workers-sdk#16349), git-over-HTTPS-only (ADR-0001), the absent
  `email_hash` table, and no `/assets` fallback target.

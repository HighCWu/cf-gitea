# RD25 postcheck — the resting-state coherence sweep (2026-10-29)

The coherence-sweep unit's deliverable: the successor to
`docs/reviews/rd24-precheck-2026-10-28.md`, run at the RD25 window's rest
point. READ-ONLY: nothing under the repo was modified except this file. No
commits were made.

Provenance and method:

- Sweep window: 2026-10-29 ~07:0x–07:3x +0800. **The tree moved during the
  sweep** — HEAD advanced `60c65e1` (the RD25 evidence commit, deploy
  `fb654a8b`) → `63e439d` (README status refresh, 06:45 +0800) → `5a97009`
  (the v1.2 tagging dossier, 06:46) → `4e3c5ba` (the post-bump staleness
  sweep, 06:46) while reading, and an in-flight UI unit holds uncommitted
  edits (§5). Every count below states which tree it read; the window-closed
  record itself (`60c65e1`) is unchanged by any of the three morning commits
  — all three are docs-only.
- Live checks executed: `gh run view 40726243702` and `gh run list` (the CI
  record, §3); `wrangler d1 execute cf-gitea --remote --json` with
  read-only SELECTs only (the sweep-fire readiness, §4 — `rows_written: 0`
  on every query, verified in the output); `pnpm check:api` at `4e3c5ba`
  (§1); `npm view miniflare` and `gh issue view` / `gh search issues` (the
  watch roster, §7).

---

## 1. Ledger coherence — specs/README.md vs reality

**Verdict: PASS on every row checked; one stale-hash nit persists
(uncarried from the RD24 precheck).**

- **Hash verification — PASS.** All eight hashes in the SPEC-0014 row
  resolve as commits (`git cat-file -t` per hash): `385f768`, `de486aa`,
  `5c59f1f`, `15e2b62`, `1c76b7d`, `cada11c`, `9e5005f`, `5f8ad0e`; plus the
  RD25 window's `f7abaa8`, `d5f8b65`, `a27ca47`, `ada3b73`, `873da29`,
  `60c65e1`, `f33860e` and the morning trio `63e439d`, `5a97009`, `4e3c5ba`.
- **SPEC-0014 row (`specs/README.md:46`) — PASS.** The row was rewritten at
  the closable batch (`0be1769`, the RD24 precheck's own prescription) and
  now reads "accepted — ratified 2026-10-28 (one binding amendment …) ·
  **landed** — M0 repo-tasks DLQ (handler `385f768` + config/dispatch
  `de486aa`), M1 gate+sweep `5c59f1f` + mount `15e2b62`, M2 banner+quotas
  `1c76b7d` + mount `cada11c` + the org-repo quota guard `9e5005f`; the demo
  battery #12 `5f8ad0e`". Every hash exists; the M0/M1/M2/battery record
  matches `git log`; no "not yet built" residue.
- **SPEC-0001 §9 tolerance classes — PASS.**
  `specs/0001-storage-engine.md:175-179`: "CI fails on >10 % regression —
  with tolerance classes (as-built 2026-10-28, the calibration commit):
  fixed-overhead wall metrics (push/fetch walls as median-of-3, inforefs
  p50/p95) fail only on >10 % AND >150 ms absolute …; byte metrics stay
  pct-only". Landed by `d5f8b65` (the spec text) with the code half in
  `f7abaa8` (median-of-3 overhead legs + absolute-floor classes); the
  benchgate's CI baseline `scripts/bench-baselines/ci.json` landed at
  `f33860e` and is ARMED (the benchmark job ran the COMPARE branch at the
  RD25 runs — see §3's WARN). Nit: §9's parenthetical says "the calibration
  commit" without naming it, while two commits wear calibration names
  across docs (`f7abaa8` the tolerance classes, `f33860e` the ci.json
  baseline) — §9's classes are `f7abaa8`; naming it would remove the
  ambiguity.
- **SPEC-0004 deleteUserCascade note — PASS.**
  `specs/0004-api-v1-core.md:96-102`: "`DELETE /admin/users/{username}`
  distinguishes `purge` like upstream's `DeleteUser` … purge drives the
  user's repos through the SPEC-0003 §2.5.5 `deleteRepository` cascade …
  before the census batch and row delete (`deleteUserCascade`,
  `src/services/user-accounts.ts`)". Landed `a27ca47` (verified). The op
  rides the already-declared `DELETE /admin/users/{username}` — re-executed
  `pnpm check:api` at `4e3c5ba` today: `declared: 490 operation(s) across
  298 path(s)`, `tier-1 coverage: 78/78 paths, 129/129 operations`, `PASS`
  with the FIVE standing documented warns (GET /user 401, POST
  /admin/cron/{task} 403, DELETE /admin/unadopted/{owner}/{repo} 404,
  GET /signing-key.gpg 404, GET /signing-key.pub 404). The README header's
  "490/554 across 298 paths" fraction therefore still holds — the purge is
  behavior on a declared op, not a new declared op.
- **Supporting-records line (`specs/README.md:52-53`) — nit persists.**
  "23/26 wire types fully emitted, refreshed through 7242825": the NUMBER
  is right, but the "through 7242825" hash is stale prose — the coverage
  audit's current edition is tick-16 (`7c57285`, the formal re-walk). The
  RD24 precheck (§1) flagged exactly this as an optional one-word fix for
  the pre-deploy docs batch; it was not carried. Same nit, third window.

## 2. PENDING-marker inventory — closable NOW vs rides the next window

**Verdict: PASS on inventory. Five closable items, of which the task's
named one (the benchgate "pending the next CI run" line) is confirmed
closable — the run it waits on is GREEN and is the milestone of §3.**

Full census (`grep -rn 'PENDING\|__BLANK__' docs/ --include='*.md'`;
historical narration excluded). **CLOSEABLE NOW:**

1. **The benchgate's pending verdict — `docs/design/p0-evidence.md:3439`**:
   "observed verdict **pending the next CI run on the bump commit** (a >10%
   regression FAILS CI — record it here if it fires)". The run happened:
   40726243702's `benchmark` job — SUCCESS (§3), i.e. the COMPARE branch of
   the armed gate held on the bumped runtime (workerd `1.20261023.1`). When
   closing the line, record BOTH runs (see §3's WARN — the bump commit's
   own run failed the same job 37 minutes earlier).
2. **The wave-131 ledger §5's items 2–3 (`docs/reviews/wave-131-landing-ledger.md:102-106`)**:
   "RD24 deploy — PENDING" and "Evidence appends — PENDING". Both resolved:
   RD24 deployed (chain `910a6aa4` → `fd571f35` → `1235b4d0`, the REDEPLOY24
   LIVE block, `p0-evidence.md:3313`); the evidence appends landed
   (REDEPLOY23 LIVE exists at `p0-evidence.md:3255` — including the honest
   "GO commit NOT RECORDED" mark; the fifth addendum in the notes). Item 1
   ("Migration 0037 — LANDED") was already flipped at the closable batch
   (`0be1769`). The §6 tension (`:108-118`) is ANSWERED by the REDEPLOY24
   discriminator sentence (first green at RD24b `1235b4d0`). Flip the two
   §5 rows to resolved pointers, like the 0037 row.
3. **The fifth addendum's PENDING block (`docs/RELEASE-NOTES-v1.2.md:572-577`)**:
   "migration **0037** … **not yet in tree**" — superseded twice over:
   `7dc607f` is in tree and the sixth addendum already names it ("the fifth
   addendum's PENDING, now in tree", `:611`), and RD24 is FINALIZED in the
   same doc (`:737-786`). The block is now the one self-contradicting text
   left in the notes; supersede it like its sibling.
4. **`docs/design/p0-package-README.md:12`** — "Production deployment +
   post-deploy probe | PENDING — deploys when the in-flight waves land
   (working tree intentionally not deployed mid-flight)". The p0 package
   has been in production since RD24 and is live as `fb654a8b` post-RD25;
   flip the row to deployed.
5. (The RD24 runbook's `__BLANK__`/PENDING paste-point text —
   `docs/ops/rd24-runbook.md:488-528` — is a window script, historical
   narration of an EXECUTED window; no action.)

**RIDES-THE-NEXT-WINDOW:**

- **The orphan cascade's observable**: the dangling `dp3t/p0-shallow` row
  first becomes eligible at the 2026-10-31 11:00 UTC hourly tick (§4). When
  the sweep consumes it: cleanup-audit's `"action"` whole-table arm 1 → 0
  and `repositories` 2 → 1. Verify at the next battery run; the REDEPLOY25
  block already records the expectation.
- **The optional seventh addendum** covering RD25's eleven commits
  (`f0eda84`→`60c65e1`) — the tagging dossier's open issue 1
  (`docs/ops/tag-v1.2-dossier.md` §2/§6); optional for tagging.
- **The v1.2 tag itself** — user decision, the dossier is prepared (§6).
- **The ubuntu-latest → 26.04 runner flip** — November 2026, upstream
  #14748 (§7); after it, re-verify the bind-family facts on the new image.
- Known riders already carried by the windows' own docs: the in-flight UI
  unit's tree (§5), the workers-sdk#16548 upstream fix (§7).

## 3. The first-green CI record — run 40726243702

**Verdict: PASS — the milestone is real, verified live via `gh`.**

`gh run view 40726243702`: conclusion **success**, status completed,
headSha `60c65e11bad0303179f2a23381bd1df744ec9957` (the evidence-complete
commit — the exact tree the milestone names), displayTitle "docs(evidence):
REDEPLOY25 LIVE — the dep-bump window's record", queued 2026-10-28T16:28:06Z,
last job completed 16:38:49Z (**10 m 43 s** wall). Seven jobs, all success,
all started 16:28:09Z:

| job | duration | verdict |
|---|---|---|
| checks | 10 m 40 s (16:28:09→16:38:49) | success |
| mirror-e2e | 1 m 46 s | success |
| lfs-e2e | 1 m 39 s | success |
| benchmark | 1 m 16 s | success |
| e2e | 1 m 12 s | success |
| diff-battery | 1 m 10 s | success |
| assets | 39 s | success |

First completed green: verified against `gh run list` — every EARLIER
completed run is failure or cancelled (push-superseded). The two benchmark
failures in the run-up: 40713069406 (on `19c7acc`, pre-calibration —
`f7abaa8` had not landed yet) and 40720149343 (on `873da29`, the bump
commit, post-calibration). The README status refresh (`63e439d`) cites the
same durations independently (checks 10m40s, benchmark 1m16s) — coherent.

**WARN (observation, not a blocker) — the benchgate flipped red→green
across two runs of identical worker code.** `873da29` (the bump commit) and
`60c65e1` differ by a docs-only commit, yet 40720149343's benchmark FAILED
at 15:51Z and 40726243702's PASSED at 16:28Z. That is runner noise
straddling the calibrated thresholds (or a nondeterministic arm) — exactly
the class `f7abaa8`'s own commit message describes ("single-shot noise on
shared runners swings 73 %+"). Job logs for the failing run were not
retrievable via `gh` (`--log` returned empty), so the failing metric is
unrecorded. When closing the §2 item-1 line: record BOTH run ids and the
flip; if the pattern repeats on future runs, the wall-metric tolerance
classes deserve a re-look (the byte metrics carry the teeth and are
byte-exact across hosts).

## 4. The sweep-fire readiness — live, read-only verified

**Verdict: PASS. Every number in the REDEPLOY25 sweep arm reconciles
against production D1 (all queries SELECT-only; `rows_written: 0` in every
result's meta).**

- **The dangling row's D1 state** — PRESENT: `repositories` id
  `fdf47576-749c-45a3-bbf1-cb47359ec328`, `owner_namespace=dp3t`,
  `slug=p0-shallow`, `owner_id=55`, `created_at` 2026-10-28 10:11:14 UTC,
  `status='ready'`, age 12.6 h at query time. `SELECT … FROM users WHERE
  id=55` returns EMPTY — the dangling-owner state the fix `ada3b73`
  targets ("the join-side NULL, not the column-side"; the day-one finding,
  `docs/reviews/demo-day1-2026-10-28.md:242`).
- **The predicate's target count** — due-now count **0** (correct: the
  retention clause `created_at < now-72h` excludes the 12.6 h-old row), and
  the eventual target set — owner unresolvable or non-admin — is **exactly
  1** (`dp3t/p0-shallow`; the join resolves no users row). The REDEPLOY25
  block's "D1 shows the predicate's target set = 1" reconciles as the
  eventual set. `repositories` total = 2; the standing fixture
  `p0probe/p0-shallow` is admin-owned (`is_admin=1`, sweep-exempt) — the
  cleanup-audit's `owner_repos=1` expectation is safe. The `"action"`
  whole-table count = **1** (the debris row's own action) — expected to go
  to 0 when the cascade fires.
- **The projected first fire** — retention boundary = created + 72 h =
  2026-10-31 10:11:14 UTC; the hourly cron `"0 * * * *"`
  (`apps/worker/wrangler.jsonc` SPEC-0014 entry) makes the first eligible
  tick **2026-10-31 11:00:00 UTC (19:00 +0800)** — the evidence's "~Oct 31"
  projection, confirmed to the hour.
- **The demo battery's ttl arm — honest-live posture VERIFIED in code**
  (`scripts/deploy-probes.mjs:3573-3585`, arm id at `:3719`):
  `demo-ttl-mechanics` is LOCAL-ONLY as a deep arm — on a DEPLOYED target
  it "records an ops-note [info] and never writes D1 … fabricating rows on
  production D1 is out of a probe's posture"; the hourly tick is
  log-observable only. REDEPLOY25 recorded demo **2 pass / 1 by-design
  posture red / 1 info** — the [info] IS the ttl arm on `$DEMO`, exactly
  the documented honest-live semantics (no pretense of a live-sweep
  verdict).

## 5. Tree hygiene

**Verdict: PASS on ship-safety (zero untracked files; the account-local
trio gitignored and current); WARN — the rest point is already disturbed:
an in-flight UI unit holds 22 modified files at sweep close.**

- **Untracked files: NONE** (checked twice during the sweep,
  `--untracked-files=all`). Submodule pristine, pin `fc4936884584a41931906553d96c2601d750e6ef`
  — unchanged from the RD24 precheck's record. `origin` =
  `github.com/HighCWu/cf-gitea` (public), HEAD == origin/main at every
  check (the morning trio is pushed).
- **The in-flight unit** — 22 modified tracked files at sweep close, all
  worker UI/session surface: `apps/worker/src/services/demo-sweep.ts`,
  `src/ui/first-run.ts`, `src/ui/shell.tsx`, `src/ui/pages/` (admin
  dashboard/monitor/orgs/repos/users, global-inbox, login,
  user-settings-* ×12, activity-author-data,
  comment-attachments-fragment). The RD25 window closed green, but the
  resting state lasted ~14 hours — the next wave is mid-flight. Re-run
  `git status --porcelain` immediately before any tagging or next-window
  GO (the standing rule).
- **The real `wrangler.jsonc` (gitignored) post-bump posture — intact and
  demo-armed**: `DEMO_MODE: "true"`, `ALLOW_SIGNUP: "true"`,
  `routes: [{ cf-gitea-demo.aiapp.run, custom_domain: true }]`, `APP_URL`
  = the workers.dev origin (the both-surfaces doctrine, day-one finding 1's
  accepted divergence), `compatibility_date: "2026-10-23"`, the hourly cron
  entry present. The committed `wrangler.jsonc.example` matches the bump:
  compat date `2026-10-23`, BOTH gates `"false"`, no routes (the fail-closed
  self-host default). `worker-configuration.d.ts` regenerated 2026-10-29
  03:45 +0800 with the `"true"` literals — current with the real config.
- **The staleness sweep (`4e3c5ba`) landed mid-sweep and fixed the drift
  this sweep would have flagged**: AGENTS.md's two hold entries (compat
  date → 2026-10-23, miniflare pin → 5.20261023.0-beta), the
  `pnpm-workspace.yaml` override comment (4.152.x → 4.153.x), and
  `check-delete-husk.mjs`'s hardcoded compat date replaced with
  `readCompatibilityDate()` (config-read with example fallback; all 6
  checks green at the read date). workers-types: declared
  `^5.20261025.1` (`packages/git-engine/package.json:24`), resolving to the
  `minimumReleaseAgeExclude` entry `5.20261027.1` — AGENTS.md's hold entry
  coherent as written.

## 6. Releases/tags — report only, the user's call

- **Only `v1.0` exists** (annotated tag object `f71b1c3`, peeled `a2ecd92`,
  2026-10-25; no GitHub Releases). The v1.1/v1.2 notes exist as docs only —
  the dossier's "coherence gap" framing confirmed by `git tag -l`.
- **A prepared decision exists**: `docs/ops/tag-v1.2-dossier.md` (`5a97009`,
  150 lines) RECOMMENDS tagging **v1.2 at `60c65e1`** — pushed, production
  == HEAD via the RD25 deploy `fb654a8b`, full gate PASS (268 files /
  0 deaths / 127.7 s), first-green CI on the bumped runtime, RD25 evidence
  complete; v1.2 spans 585 commits since v1.0; one command to execute
  (`git tag` + `git push origin v1.2`); an optional back-dated v1.1 and an
  optional seventh addendum are the dossier's open items.
- **One delta the dossier could not know**: HEAD has since advanced to
  `4e3c5ba` (three docs-only commits: README refresh, the dossier itself,
  the staleness sweep) and the UI unit of §5 is in flight — if the user
  waits for the next rest point, the cut point moves; the dossier's
  rationale is tied to `60c65e1` as the DEPLOYED tree, which remains true
  regardless of where docs HEAD drifts. **Report only; tagging is a user
  call — nothing was tagged here.**

## 7. The watch roster — current states, verified live 2026-10-29

- **workers-sdk#16548** (our DDL filing — one un-drained SqlStorage cursor
  bricks DROP TABLE with SQLITE_LOCKED for the session): **OPEN**. Filed
  2026-10-28 14:46Z, last updated 14:49Z (no upstream response yet).
  Records: `docs/research/workerd-ddl-cross-session-locked.md:3` (FILED
  status), `docs/RELEASE-NOTES-v1.2.md:908` (the same-day rider note).
- **workers-sdk#16349** (the warm-module inlining / 32 MiB WebSocket 1009
  issue we contributed the 33,309,508 B pass to): **OPEN**. Created
  2026-10-18, last updated 2026-10-28 12:48Z (the contribution comment;
  `#16515` was closed as its duplicate per `docs/RELEASE-NOTES-v1.2.md:883-885`).
- **The miniflare-5-GA revisit trigger: NOT FIRED.** `npm view miniflare`:
  dist-tag `latest` = `4.20260730.0`; NO stable 5.x exists (newest:
  `5.20261023.2-beta`). Our override: `5.20261023.0-beta`
  (`pnpm-workspace.yaml:20`), AGENTS.md's hold entry current post-`4e3c5ba`.
  The trigger condition ("revisit at miniflare 5 GA") remains dormant.
- **The ubuntu-26 runner migration notice:
  actions/runner-images#14748** — "[Ubuntu] `ubuntu-latest` label will use
  Ubuntu 26.04 in November 2026" — **OPEN**, updated 2026-10-28 (verified
  live; ubuntu-26.04 itself GA'd per #14747, 2026-10-12). Our
  `.github/workflows/ci.yml` pins `ubuntu-latest` on all 8 jobs. After the
  flip: re-verify the localhost→::1 bind-family facts
  (AGENTS.md, Local dev & CI environment, `05bcd56`) on the new image, and
  watch the 26.04 known issues relevant to this repo — #14777 (`/tmp` is
  now a RAM-backed tmpfs with ~7.8G per-user quota — the assets job's
  scratch-dir asset builds) and #15028 (agent directory structure change).

---

## VERDICT

**RESTING-STATE-COHERENT** — no blocking defect in the ledgers, the CI
record, the remote D1 state, the deployed posture, the toolkit's posture,
or the tree's ship-safety. The window-closed record (`60c65e1` / deploy
`fb654a8b` / run 40726243702) is internally consistent end to end.

Closable NOW (§2, none blocks): the benchgate pending line
(`p0-evidence.md:3439` — the run is green); the wave-131 §5 items 2–3; the
fifth addendum's PENDING block (`RELEASE-NOTES-v1.2.md:572-577`); the
p0-package README's PENDING row (`p0-package-README.md:12`).

WARN findings:

1. The benchgate flipped red→green across two runs of identical worker code
   (`873da29` FAIL → `60c65e1` PASS, docs-only delta) — runner noise
   straddling the calibrated thresholds; the failing metric is unrecorded
   (log not retrievable). Record BOTH run ids when closing the pending
   line; watch for a repeat.
2. The "refreshed through 7242825" stale-hash nit
   (`specs/README.md:52-53`) persists for a third window (the number 23/26
   is right; the coverage doc's current edition is tick-16 `7c57285`).
3. SPEC-0001 §9's "the calibration commit" names no hash (`f7abaa8` is the
   one; `f33860e` wears a calibration name too, for the ci.json baseline).
4. The standing-nine plan census (114 at runtime dry-run) vs the observed
   live total (113, both RD24 and RD25) — the recurring −1 is the known
   chain-skip class and both evidence blocks derive from verdicts, not the
   plan ("don't force-match"), but a one-line reconciliation of WHICH arm
   runs short live would close the book permanently.

Open issues for the next reader:

- The in-flight UI unit (22 modified files, §5) — the rest point is already
  disturbed; re-check `git status --porcelain` before tagging or the next
  GO.
- The orphan cascade fires ~2026-10-31 11:00 UTC (§4): expect `"action"` 1→0
  and `repositories` 2→1; verify at the next battery run and close the
  REDEPLOY25 block's expectation line.
- The v1.2 tag decision awaits the user (§6) — the dossier is ready; the
  only new input since its writing is the three morning docs commits and
  the in-flight unit.
- REDEPLOY23's "GO commit NOT RECORDED — orchestrator fills" slot
  (`p0-evidence.md:3255` block) is still open prose; the block's own
  convention permits the honest mark to stand if the GO commit is
  unrecoverable from the landing docs.

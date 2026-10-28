# RD25 deploy runbook — the dep-bump window (pre-written)

Status: PRE-WRITTEN 2026-10-28 by the RD25-runbook unit (read-only; this file is
the unit's only deliverable). Every command/flag below was verified against the
tree at HEAD `aa9d5ba` (the post-RD24 CI-stabilization wave; RD24's frozen
record ends at `docs/RELEASE-NOTES-v1.2.md:737-786`). The window's payload is
the dependency-freshness census's Window 1 (`docs/research/dep-freshness-2026-10-28.md:110-142`):
**5 bumps + 2 coordinated config edits**, executed under the quiet-window
discipline. Steps that depend on an in-flight landing (only the bench-baseline
item, §6) are marked **(after X)** — do not execute them until the named
condition holds. The orchestrator executes this top to bottom; each step names
its expected output and its failure branch. Never `git commit` inside the
window except the pre-agreed dep-bump commit (§4.1) and the evidence/finalization
appends (§7), and only per the AGENTS.md commit policy.

Conventions used below:

- PROD = `https://cf-gitea.hecongw.workers.dev` (the standing deployment;
  `docs/ops/runbook.md:190`).
- DEMO = `https://cf-gitea-demo.aiapp.run` (the SPEC-0014 demo instance,
  live since RD24b — `docs/RELEASE-NOTES-v1.2.md:770-772`).
- GO_COMMIT = the dep-bump commit the orchestrator lands in §4.1 (record it).
  PRE_BUMP_COMMIT = HEAD at window open (record it too — rollback §8.2 needs it).
- Battery toolkit = `scripts/deploy-probes.mjs`; smoke = `scripts/deploy-smoke.mjs`.

## 1. Preconditions checklist (all must hold before opening the window)

1. **Tree quiet.** `git status --porcelain` → empty; `git -C gitea status
   --porcelain` → empty (if `gitea/pnpm-lock.yaml` shows modified:
   `git -C gitea checkout --`). No dev servers on 5173/5199/8443, no sibling
   vitest/wrangler processes, no background agents mid-flight on the shared
   tree (the quiet-window definition, RD24 runbook §1.4). Post-RD24 there is
   an active CI-stabilization stream on `main` (at write time the latest runs
   were red/cancelled — engine-check wiring and docs pushes in flight); the
   window opens only from a quiet, committed tree.
2. **The RD24 record is current.** Read the frozen RD24 block
   (`docs/RELEASE-NOTES-v1.2.md:737-786`): deploy chain GO `910a6aa4` →
   `fd571f35` (demo flip) → `1235b4d0` (RD24b freeze); migrations 0036 + 0037
   applied remote; the demo posture armed; the repo public at
   `github.com/HighCWu/cf-gitea` (origin verified: `git remote -v`). If the
   record moved since write time, re-verify the delta against §§4-5 below.
3. **Remote state sanity (read-only):**
   ```bash
   wrangler d1 migrations list cf-gitea --remote   # expect ZERO pending rows
   wrangler secret list                            # GIT_TOKEN, MIRROR_ALLOWED_HOST_LIST, MIRROR_CREDENTIAL_KEY
   wrangler queues list                            # repo-tasks, repo-tasks-dlq, webhook-delivery, webhook-delivery-dlq
   ```
   **RD25 expects NONE pending** — 0036/0037 applied at RD24 and the tree's
   migrations end at `0037_smart_blizzard.sql` (verified: no 0038 exists). A
   pending row means a sibling shipped a migration after the census → STOP and
   re-scope (the window's schema-silence claim in §5.2 dies with it). A missing
   secret → `wrangler secret put <name>` BEFORE deploy. `repo-tasks-dlq`
   missing → `wrangler queues create repo-tasks-dlq` (created at RD24; the
   consumer declares it, `apps/worker/wrangler.jsonc:162`, and a missing DLQ
   at deploy time is the M0 silent-drop class, `docs/ops/deploy-notes.md:60-64`).
4. **THE DEMO POSTURE DRIFT CHECK (explicit, before any config edit).** The
   real, gitignored `apps/worker/wrangler.jsonc` carries the RD24 demo posture
   ON DISK and RD25's deploy MUST PRESERVE it — the vars ride the committed-to-
   disk config through every build; the bump window must not regress them:
   - `"DEMO_MODE": "true"` (`apps/worker/wrangler.jsonc:48`),
   - `"ALLOW_SIGNUP": "true"` (`:53`),
   - the custom-domain route `"routes": [{ "pattern": "cf-gitea-demo.aiapp.run",
     "custom_domain": true }]` (`:11`) + `"workers_dev": true` (`:10`),
   - `APP_URL` = the workers.dev origin (`:41`).
   RD25's edit to this file touches ONLY `compatibility_date` + its comment
   (§2.2). Never regenerate the real config from the example — the example
   defaults BOTH gates `"false"` (`wrangler.jsonc.example:45,53`) and carries
   no route; restoring from it would silently stand the demo down (the gates
   are fail-closed: `docs/ops/deploy-notes.md:65-70`, SPEC-0014 §6.8). CI
   restoring from the example is CI's business (`ci.yml:245-246`) — a local
   deploy must not. `pnpm setup:deploy -- --check` is the read-only drift
   probe if anything looks off (`docs/ops/deploy-notes.md:19`).
5. **The census is still the plan.** The five Window-1 targets were
   gate-eligible at census time; the three WAIT variants have eligibility
   clocks (`docs/research/dep-freshness-2026-10-28.md:40-43`): wrangler
   4.154.0 (10-28 17:06Z), vitest-plugin 1.4.9 (17:11Z), workers-types
   5.20261028.1 (10-29 01:08Z). **This matters for §2.3's commands**: after
   those instants, a bare `pnpm up <pkg>` resolves the WAIT variants, whose
   miniflare pin is `5.20261023.1-beta` — NOT the census plan (the override
   would mask it at runtime, but the toolchain pair would drift a day ahead of
   what the census verified). §2.3 therefore pins exact versions.

## 2. The coordinated edits FIRST, then the refresh (census Window 1)

The shared-file edits are orchestrator-owned (`dep-freshness-2026-10-28.md:181-183`).
Do them BEFORE the update commands so one resolution pass applies everything.

### 2.1 `pnpm-workspace.yaml`

- `overrides.miniflare`: `5.20261019.2-beta` → **`5.20261023.0-beta`**
  (`pnpm-workspace.yaml:19-20`) — the exact pin wrangler 4.153.0 +
  vitest-plugin 1.4.8 both declare (`dep-freshness-2026-10-28.md:66-74`);
  forcing vite-plugin 1.65.0 (still pinned to the 10-19 beta) four days up the
  same 5.x train is the census's accepted trade (`:92-99`).
- Update the override's explanatory comment (`:12-15`) — it cites "wrangler
  4.152.x"; now 4.153.x.
- The `minimumReleaseAgeExclude` entry (`:16-17`) pins
  `@cloudflare/workers-types@5.20261025.1`, which goes stale the moment the
  engine moves to 5.20261027.1. Apply the census's durable form: make it
  name-only, `- "@cloudflare/workers-types"` (legal per the registry docs the
  census cites, `:118-121`; the stale-but-harmless alternative and the
  recommendation are `:183-185`). This stops the daily-types train needing a
  per-bump edit.

### 2.2 BOTH wrangler configs' `compatibility_date` → `2026-10-23`

workerd `1.20261023.1` (carried by miniflare `5.20261023.0-beta`) is the
newest runnable date; the bump is production-safe — the compat date only picks
the semantics cutoff and the deployed runtime is far newer
(`dep-freshness-2026-10-28.md:44,100-105`). Edit:

1. `apps/worker/wrangler.jsonc:17` + its comment (`:12-16` — rewrite the
   "re-verified 2026-10-25 / wrangler 4.152.0" text to "wrangler 4.153.0 pairs
   miniflare 5.20261023.0-beta / workerd 1.20261023.1"). **Vars/routes/limits
   are NOT touched** (§1.4).
2. `apps/worker/wrangler.jsonc.example:10` + its comment (`:5-9`) — the
   committed template must match, or CI (which restores from the example,
   `ci.yml:245-246`) would run a different compat date than the deploy.

### 2.3 The refresh — exact-version form (gate-safe at any clock)

All five targets sit inside the declared `^` ranges, so this is a pure
lockfile refresh (no manifest edits; ranges verified: hono `^4.13.13`
`apps/worker/package.json:20`, wrangler `^4.152.0` `:32`, vitest-plugin
`^1.4.7` `:25`, typescript-eslint `^8.72.0` root `package.json:37`,
workers-types `^5.20261025.1` `packages/git-engine/package.json`):

```bash
pnpm install                                                  # lands the override re-resolution first
pnpm -w up typescript-eslint@8.72.1
pnpm --filter cf-gitea-worker up hono@4.13.14 wrangler@4.153.0 '@cloudflare/vitest-plugin@1.4.8'
pnpm --filter @cf-gitea/git-engine up '@cloudflare/workers-types@5.20261027.1'
```

(The census's Window-1 list uses bare `pnpm up` — correct at census time; the
exact forms here are the same plan made clock-independent, per §1.5.
`hono 4.13.14` is the exact version AGENTS.md recorded gate-blocked on 10-25;
it cleared the gate 10-26T07:19Z — `dep-freshness-2026-10-28.md:185-186`.)

**Expected lockfile drift** (census `:138-141`): exactly the five versions
above; `miniflare` snapshots `5.20261019.2-beta` → `5.20261023.0-beta`;
`workerd` → `1.20261023.1`; sibling toolchain churn (`unenv`, `youch`
prereleases ride the train). Verify the interlock with your own eyes:

```bash
pnpm why miniflare   # exactly ONE version: 5.20261023.0-beta (the single-version
                     # invariant's method: docs/research/miniflare-beta-pin.md:23-37)
pnpm why workerd     # 1.20261023.1
```

Any OTHER miniflare version in the tree, or drift beyond the named set → STOP,
diff `pnpm-lock.yaml` hunk-by-hunk before proceeding (AGENTS.md pre-commit
checklist discipline).

## 3. The QUIET-WINDOW gate + the bump's local verification

### 3.1 Typecheck + lint

```bash
pnpm typecheck   # = pnpm -r typecheck; the worker's script IS "wrangler types && tsc --noEmit"
                 # (apps/worker/package.json:9) — this step regenerates Env types AND the
                 # engine dist-types boundary; no separate `wrangler types` call is needed
pnpm lint
```

Expected: 0 errors both (RD24's green line, `docs/RELEASE-NOTES-v1.2.md:751`).
A `wrangler types` failure here means the config edit in §2.2 broke the schema
— fix the edit, not the generated file (`worker-configuration.d.ts` is
gitignored, regenerated).

### 3.2 The full-suite composite gate

```bash
pnpm test:full   # = CF_TEST_STRIP_SOURCEMAPS=1 node scripts/full-suite-gate.mjs --solo (package.json:16)
```

Verdict protocol = ADR-0006, quoted semantics in RD24 runbook §2
(`docs/ops/rd24-runbook.md:80-113`): phase-1 exact attribution, phase-2 `--solo`
adjudication, assertion failures fatal, a green single-pass `vitest run` proves
nothing. **Gate: exit 0 and the attribution line seen with your own eyes.**
Reference line: RD24 ran **268 files, 266 direct + 2 solo-green (pull-engine +
demo-quota, the load-flaky class), 0 deaths** (`docs/RELEASE-NOTES-v1.2.md:749-751`);
expect ≈268+ (post-RD24 test waves may add files). Wall budget ~15-20 min.

- Pool misbehavior attributed to the moved override (new startup deaths that
  also die solo, workerd boot failures, `vite dev` breakage) is a **BLOCKER**,
  not a waiver: the census's rollback doctrine is restore override
  `5.20261019.2-beta` + wrangler 4.152.0 and re-verify
  (`dep-freshness-2026-10-28.md:97-99,141-142`; doctrine in
  `docs/research/miniflare-beta-pin.md`). §8.2 is the mechanical form.
- The known 8-worker saturation class (5000 ms hook timeouts that pass solo)
  is adjudicated by the gate's own solo phase — no manual waiver (RD24 §2).

### 3.3 The engine checks on the moved runtime — delete-husk is the pinned-runtime member

```bash
node packages/git-engine/e2e/check-delete-husk.mjs
```

Expected: six `ok:` lines then **`all 6 engine checks passed`**
(`check-delete-husk.mjs:282-288`). **The pinned-runtime shape, noted for the
evidence:** the script bundles the engine with a store-resolved esbuild and
runs it on the repo's pinned miniflare/workerd, located by the PREFIX
`miniflare@5.` with "the NEWEST matching store entry wins"
(`check-delete-husk.mjs:43-56`) — **the pin MOVES with the §2.1 override
automatically; no engine edit is needed for the bump**, and the runtime under
test becomes miniflare `5.20261023.0-beta` / workerd `1.20261023.1` for free.
Two notes: (a) its `compatibilityDate: "2026-10-19"` is HARDCODED
(`:129-131`) and stays runnable — a workerd accepts dates up to its own build
date — but the "exactly the dev server's" parity comment now drifts four days
from `wrangler.jsonc`; a one-line alignment is a follow-up for the next
engine-touching unit (open issue 2). (b) This check exists precisely because
its failure mode (`SQLITE_LOCKED` on cross-session DDL, workerd#959) is a
property of the runtime's SQLite storage (`NOTICE.md:149`) — a red on the NEW
workerd is a runtime regression signal, treat as a blocker, not flake.
If the engine-checks CI wiring that was in flight at write time ("ci: wire
the seven new engine checks") has landed with a local runner, run it too; the
remaining tsx checks are node:sqlite-harness scripts, runtime-independent
(`packages/git-engine/e2e/README.md:131`).

### 3.4 The dev-server harness set (the strongest local signal on the new pool)

Start the dev server (it now runs on the new miniflare/workerd):

```bash
pnpm dev   # background; wait for GET http://127.0.0.1:5173/healthz → 200
```

A failed/slow boot here is itself a bump blocker (workerd cannot run the new
compat date → re-check §2.2 vs §2.1 coherency). Then, per the standing shapes
(RD24 runbook §2b, `docs/ops/rd24-runbook.md:115-150`):

1. **LFS relay** — `pnpm test:lfs` (= `bash scripts/lfs-e2e.sh`; starts its
   own server if none answers). Expected `=== RESULT: 33 passed, 0 failed ===`,
   exit 0.
2. **Engine e2e set-equality** —
   ```bash
   PATH="$PWD/packages/git-engine/e2e/shim:$PATH" \
     packages/git-engine/e2e/e2e.sh http://127.0.0.1:5173/demo devtoken
   ```
   Expected steady state **34 passed / 35 failed** (exit 1 by design;
   `docs/ops/runbook.md:47-56`). Extract the failure set the way CI does
   (`ci.yml:176`) and diff against the job's allowlist — **empty diff = pass**
   (the method verbatim: RD24 runbook §2b). An environmental cascade (stale-cell
   rejections) → stop the server, remove the locked cell's SQLite file under
   `apps/worker/.wrangler/state/v3/do/cf-gitea-RepoCell/`, restart, re-run once.

Kill the dev server before continuing.

## 4. The commit point + the deploy

### 4.1 The dep-bump commit (the window's one pre-agreed code commit)

All green in §3 → the orchestrator commits the unit ATOMICALLY via pathspec
(agents never commit; AGENTS.md policy; only paths that exist in git):

```bash
git add pnpm-lock.yaml pnpm-workspace.yaml apps/worker/wrangler.jsonc.example
git commit -m "chore(deps): the census Window-1 bump — hono 4.13.14, wrangler 4.153.0,
vitest-plugin 1.4.8, typescript-eslint 8.72.1, workers-types 5.20261027.1;
override miniflare 5.20261023.0-beta; compat date 2026-10-23 (both configs)" \
  -- pnpm-lock.yaml pnpm-workspace.yaml apps/worker/wrangler.jsonc.example
git show --stat HEAD   # verify ONLY those three paths landed
```

Record GO_COMMIT (= this commit) and verify with `git status --porcelain` that
nothing else is staged. **The real `wrangler.jsonc` is gitignored — it is NOT
in this commit** (its compat-date edit rides the deploy, not the tree). The
AGENTS.md holds-list sync is a docs-batch item (§7.3), not part of this commit.

### 4.2 The deploy — build AFTER the edits, ALWAYS (the stale-dist trap)

```bash
pnpm build && pnpm deploy
wrangler deployments list   # newest row "Created" moments ago at 100% — RECORD the Version ID
```

**THE STALE-DIST TRAP is this window's standing lesson, found at RD24's own
flip:** wrangler deploys `dist/`'s GENERATED config — RD24's demo vars/routes
"never rode until a fresh build" (`docs/RELEASE-NOTES-v1.2.md:744-746`; the
trap's original record, `docs/ops/runbook.md:180-190`). RD25 edits the same
file's compat date: **a dist built before §2.2 would deploy 2026-10-19 while
the tree says 2026-10-23.** `pnpm build` (which runs `prebuild` → `gen:icons`,
`package.json:24`) must be the LAST action before `pnpm deploy`, every time,
no exceptions.

- Expected deploy output: a new Version ID (UUID) at 100% — record it (the
  RD23/RD24 lineage convention: every evidence block lists the chain). Health
  spot-checks, BOTH surfaces:
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" $PROD/healthz   # → 200
  curl -s -o /dev/null -w "%{http_code}\n" $DEMO/healthz   # → 200 — the custom domain survived the redeploy
  ```
  A DEMO 522/SSL error → cert re-provisioning, retry after a few minutes
  (RD24 §6 failure branch) before diagnosing further.
- **Migrations: CHECK ONLY, DO NOT APPLY.**
  ```bash
  wrangler d1 migrations list cf-gitea --remote   # still ZERO pending (re-affirm post-deploy)
  ```
  `pnpm db:migrate:remote` would be a no-op — running it is harmless but the
  check is the point: RD25 is schema-silent (0036/0037 applied at RD24, both
  index-only, the 65-table count stands — `docs/RELEASE-NOTES-v1.2.md:746-749`).
  A NEW pending row appearing here (impossible from this tree — no 0038
  exists) means the deploy came from a tree you did not think it did → STOP.
- Failure branches: config/database_id drift → `pnpm setup:deploy -- --check`
  (read-only; `docs/ops/deploy-notes.md:19`), rebuild, never hand-edit
  `dist/`; healthz 5xx after one diagnosis pass (observability traces are on,
  `wrangler.jsonc.example:55-60`) → §8.1 rollback.

## 5. Post-deploy verification

### 5.1 PAT minting discipline — carried verbatim

The full discipline (mint per run via
`node scripts/bootstrap-admin.mjs p0probe --remote`, 0600 temp file, shred at
wrap, `--token-file` enforcement + the `cfg_<8hex>_<32base32>` shape, never
echoed, delete the per-run PAT at teardown) is RD24 runbook §5.1
(`docs/ops/rd24-runbook.md:210-247`) — unchanged, execute it as written with
`/tmp/rd25-*` temp names. The shape check and the authorization probe:

```bash
node scripts/bootstrap-admin.mjs p0probe --remote 2>/tmp/rd25-mint.err \
  | grep -oE 'cfg_[0-9a-f]{8}_[A-Z0-9]{32}' | head -1 > /tmp/rd25-pat.txt
chmod 600 /tmp/rd25-pat.txt /tmp/rd25-mint.err
grep -cE '^cfg_[0-9a-f]{8}_[A-Z0-9]{32}$' /tmp/rd25-pat.txt   # → 1
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: token $(cat /tmp/rd25-pat.txt)" \
  $PROD/api/v1/user    # → 200
```

### 5.2 `pnpm smoke`

```bash
pnpm smoke -- --base-url $PROD --user p0probe --migrate-check \
  --token "$(cat /tmp/rd25-pat.txt)"
```

(Flags verified `scripts/deploy-smoke.mjs:105-107`: `--base-url` required,
`--token`, `--user`, `--migrate-check`, `--bench-report`, `--timeout-ms`,
`--json`.) Expected: **6 pass / 0 fail / 1 skip**, `ok: true`. The
`migrate-check` expectation for RD25: **"No migrations to apply" AND the
standing table census UNCHANGED — a dependency bump is schema-silent; any
table-count delta means something other than the census five shipped.**

### 5.3 The 12 batteries

`BATTERY_NAMES` carries 12 + `all` (`scripts/deploy-probes.mjs:251`): p0,
registry, generate-e2e, forkpr-e2e, mirror, ui-login, window2-mounts,
window3-mounts, fixwave-parity, branch-protection, **demo**, cleanup-audit.
Shared invocation (any HTTP battery REQUIRES `--base-url` + `--token-file`;
`deploy-probes.mjs:308-312`):

```bash
node scripts/deploy-probes.mjs <battery> --base-url $PROD --token-file /tmp/rd25-pat.txt
```

Run, in this order:

1. **The standing nine** — census **113 checks** (the wave-131 ledger §1
   arithmetic; RD24 verdict 113/0, `docs/RELEASE-NOTES-v1.2.md:750-751`):
   `p0` 4 (the fixture self-seeds when absent — `deploy-probes.mjs:332`) ·
   `registry` 21 (`--trials` default 3) · `generate-e2e` 10 · `forkpr-e2e` 8 ·
   `mirror` 8 · `ui-login` 5 · `window2-mounts` 22 · `window3-mounts` 25 ·
   `cleanup-audit` 10. Expected: all green (the RD24 verdict line,
   `docs/RELEASE-NOTES-v1.2.md:753`).
2. **fixwave-parity** — 22 checks, ADMIN PAT, wrangler auth (`--d1-scope
   remote` is the default, `deploy-probes.mjs:276`). Expected 22/0, and
   **`fw-org-member-preaccess` (`deploy-probes.mjs:2765`) GREEN**. Semantics
   change from RD24: its first-green was RD24b (`1235b4d0`,
   `docs/RELEASE-NOTES-v1.2.md:755-756`) and the carrying code (the org grant
   + the `auto_init` route fix, `9d77172`) is an ancestor of every version
   since — **a red at RD25 is a REGRESSION, not a ride.** Diagnose against
   `wrangler deployments list` (is the live version the one just deployed?),
   do NOT re-write the RD24 discriminator sentence.
3. **branch-protection** — 18 checks, ADMIN PAT. Expected 18/0 (RD24 verdict,
   `docs/RELEASE-NOTES-v1.2.md:753-754`). Optional rehearsal of the committed
   force-red arm, if the orchestrator wants the sweep proof again:
   `--force-red bp-merge-blocked-405` then a green `cleanup-audit` (RD24 §5.5
   shape, `docs/ops/rd24-runbook.md:349-371`).
4. **demo — the live posture post-demo-domain (the RD25-specific arm).** Run
   it against the DEMO surface:
   ```bash
   node scripts/deploy-probes.mjs demo --base-url $DEMO --token-file /tmp/rd25-pat.txt
   ```
   Four arms (`deploy-probes.mjs:3674-3761`), with RD25 expectations:
   - `demo-config-posture` (`:3676`) — **REDS BY DESIGN on this machine.** It
     reads the on-disk configs and asserts `DEMO_MODE` defaulting `"false"`
     (`deploy-probes.mjs:3645-3671`); the real config is flipped
     `"true"` (§1.4). RD24's frozen record is exactly this verdict:
     "the config-posture arm reds BY DESIGN on the flipped operator machine"
     (`docs/RELEASE-NOTES-v1.2.md:757-759`). Record the red as the documented
     posture; do not "fix" it — the arm guards the self-host default.
   - `demo-banner-present` (`:3687`) — must **PASS**. The banner arm asserted
     hard at RD24 post-flip (M2 mounted, `cada11c`); the pre-M2 `[warn]`
     branch (`:3693-3697`) is dead code on this deployment — a warn here means
     the banner regressed.
   - `signup-open` (`:3706`) — must **PASS** (200 + the registration form on
     the ALLOW_SIGNUP-open demo posture; a 404 is a posture red).
   - `demo-ttl-mechanics` (`:3719`) — records the documented **[info]** on a
     deployed target (the hourly tick is log-observable only). The deep local
     arm is OPTIONAL: with the §3.4 dev server up and `DEMO_MODE="true"` in
     `apps/worker/.dev.vars` (the var is declared, so the override loads —
     `wrangler.jsonc:49-53`), run `--base-url http://127.0.0.1:5173
     --d1-scope local`; it fabricates the 72 h row, ticks
     `/cdn-cgi/local/scheduled`, and polls the row gone. Same posture as RD24
     (info-only live); not a regression gate.
5. **cleanup-audit** — the wrap (§5.5).

Record the observed total; RD24's recorded sum was 155 live checks
(`docs/RELEASE-NOTES-v1.2.md:760`) — derive RD25's from the verdicts,
don't force-match.

Verdict parsing: the multi-object JSONDecoder scan is the orchestrator's
evidence convention, NOT in-tree — RD24 runbook §5.6
(`docs/ops/rd24-runbook.md:375-403`) carries the loop verbatim; scan every
parsed object for `status != "pass"` before declaring a battery green.
Failure branch (any battery): the battery self-cleans — read the
`[tail] <battery>-leftover-sweep` line, then a green `cleanup-audit` is the
sweep's proof; a genuine product red → STOP that arm's evidence, decide
fix-forward vs §8.1.

### 5.4 Cleanup audit + PAT teardown (the wrap)

```bash
node scripts/deploy-probes.mjs cleanup-audit --d1-scope remote
```

Defaults are the production expectations (`deploy-probes.mjs:276,343`):
`--user p0probe`, `--expect-owner-repos 1` (the standing p0-shallow fixture,
self-seeded by p0 if absent), `--expect-tokens 1` (the standing bootstrap
PAT). Green = the eight zero-count tables + repos == 1 + tokens == 1
(`deploy-probes.mjs:3794-3802,3851,3869`; RD24 §5.7's list). Then the PAT
teardown: delete the per-run PAT by id/prefix, `shred -u
/tmp/rd25-pat.txt /tmp/rd25-mint.err`, re-run the audit → still green with
tokens == 1. Paste the "every battery self-cleaned … back to the standing
bootstrap = 1" line (RD24 §5.7).

## 6. The post-green CI item — commit `scripts/bench-baselines/ci.json` **(after a green public CI run)**

State at write time: `scripts/bench-baselines/` carries `m2.json` only —
`ci.json` is NOT committed (verified at HEAD `aa9d5ba`), and `main`'s latest
CI runs were red/cancelled (the CI-stabilization wave is mid-flight; runs
40698670897/40699163809/40699376701). The benchmark job self-bootstraps its
CI-hardware baseline: on a run where `ci.json` is absent it RECORDS it
(report-only pass) and uploads artifact **`bench-ci-baseline`**, printing the
in-log notice *"commit it from artifact bench-ci-baseline so the next run
gates"* (`ci.yml:302-317`; the local-vs-local BASELINE POLICY is
`scripts/bench-run.mjs:64-77`, and `--compare m2` is forbidden — machine
variance, `ci.yml:228-231`). Committing the file arms the enforced >10%
CI-vs-CI gate (`ci.yml:224`). Execute only from a run whose benchmark job
went green:

```bash
gh run list --repo HighCWu/cf-gitea --workflow CI --branch main \
  --status success --limit 10                      # pick the newest green run
gh run view <run-id> --repo HighCWu/cf-gitea \
  --json jobs --jq '.jobs[] | select(.name=="benchmark") | .conclusion'
                                                   # must print "success"
gh run download <run-id> --repo HighCWu/cf-gitea \
  -n bench-ci-baseline -D /tmp/rd25-bench          # → /tmp/rd25-bench/ci.json
jq -e . /tmp/rd25-bench/ci.json >/dev/null && echo ok   # parse check; eyeball the 5m fixture's metrics
cp /tmp/rd25-bench/ci.json scripts/bench-baselines/ci.json
```

Commit: the ORCHESTRATOR, via pathspec, referencing the run id:

```bash
git add scripts/bench-baselines/ci.json
git commit -m "ci(bench): the CI-hardware baseline from artifact bench-ci-baseline (run <run-id>)" \
  -- scripts/bench-baselines/ci.json
```

Never hand-edit the JSON — a bad baseline gates every future run at >10%.
Verification on the NEXT main push: the benchmark step takes the COMPARE
branch (`ci.yml:304-305`) and the `::notice` recording line is GONE. If the
download fails (artifact absent — `if-no-files-found: ignore`,
`ci.yml:317`), pick an earlier green run with the artifact; if NO green run
exists yet, this item waits (it is "post-green" by definition).

## 7. Evidence + finalizations

### 7.1 The evidence block

Append the **RD25 LIVE** block to `docs/design/p0-evidence.md` after the
REDEPLOY24 block (`:3305` through EOF) following that shape: header (TIME ·
PRE_BUMP_COMMIT · GO_COMMIT · the deploy Version ID · healthz on BOTH
surfaces) · the five bump lines with resolved versions from the lockfile diff ·
the `pnpm why miniflare`/`workerd` single-version lines · the full-gate
verdict line at GO · typecheck/lint · `pnpm smoke (--migrate-check)` ·
per-battery verdicts incl. the demo posture's 2-pass/1-by-design-red/1-info ·
the delete-husk "all 6 engine checks passed" line WITH the moves-with-the-
override note (§3.3) and the hardcoded-date drift note · the migration
check-only line (NONE pending, 0036/0037 stand) · the cleanup-audit/PAT
teardown line · the bench-baseline commit's run id (if §6 executed).

### 7.2 RELEASE-NOTES

A short RD25 record after the RD24 block (`docs/RELEASE-NOTES-v1.2.md:786`):
the census (`4d039cb`) is already referenced at `:735`; RD25 = Window 1
executed (the five + override + compat date), the WAIT trio's eligibility
dates restated as the next natural refresh (census §4 Window 2,
`:144-152`), the deploy Version ID, and the schema-silence line (no
migration, 65-table count stands).

### 7.3 AGENTS.md holds-list sync (orchestrator-owned shared file)

The Dependencies section's intentional holds change with this window:
- `compatibility_date 2026-10-19` — the hold LIFTS ("no longer held once
  window 1 lands — tracks the workerd pin", `dep-freshness-2026-10-28.md:160-161`);
  the entry becomes the standing discipline note ("newest date the pinned
  runtime supports", currently 2026-10-23).
- the transitive-miniflare entry's version string `5.20261019.2-beta` →
  `5.20261023.0-beta` (the wrangler/vite-plugin/vitest-plugin EXACT-pin
  doctrine itself is unchanged, `:162-163`).
- the hono 4.13.14 gate observation (`AGENTS.md`, "observed 2026-10-25") has
  aged as predicted (`:185-186`) — may be reworded as resolved.

## 8. Rollback

Two independent halves — the deployed artifact and the tree's toolchain. A
bad compat date affects production (half 1); a bad lockfile affects local
dev/CI only (half 2). Use whichever half the failure lives in; both if both.

### 8.1 Version-id rollback (the deploy)

```bash
wrangler deployments list        # read the version IDs + Created timestamps; the live row is 100%
wrangler rollback <version-id>   # the PRE-RD25 version id (RD24b's freeze `1235b4d0` or any later)
```

(Standard wrangler v4 CLI; if the now-pinned wrangler 4.153.0 changed the
invocation, `wrangler rollback --help` governs — RD24 open issue 5 carried
forward.) Re-verify: PROD + DEMO healthz 200; the demo posture intact (the
pre-RD25 version carries the flip); `pnpm smoke` green. D1 needs NOTHING:
RD25 ships no migration; 0036/0037 are index-only and applied — untouched by
rollback; never touch `d1_migrations` (the RD24 §8 doctrine,
`docs/ops/rd24-runbook.md:585-609`). `fw-org-member-preaccess` stays GREEN on
any rollback target ≥ RD24b (the code predates it); only a rollback to
pre-RD24 would red it.

### 8.2 The dep-bump revert (the lockfile — via git, per the census doctrine)

Trigger: pool/dev/workerd misbehavior attributed to the moved override, at any
point after §2 (the census: "treat any pool misbehavior as a blocker … the
documented rollback is to restore override 5.20261019.2-beta + wrangler
4.152.0 and re-verify", `dep-freshness-2026-10-28.md:97-99,141-142`).

- BEFORE the bump commit exists (§4.1 not yet run):
  ```bash
  git checkout HEAD -- pnpm-lock.yaml pnpm-workspace.yaml apps/worker/wrangler.jsonc.example
  ```
- AFTER it (restore the three paths from PRE_BUMP_COMMIT; do NOT reset/rebase —
  AGENTS.md git safety):
  ```bash
  git checkout PRE_BUMP_COMMIT -- pnpm-lock.yaml pnpm-workspace.yaml apps/worker/wrangler.jsonc.example
  ```
- Then HAND-restore the real config's compat date (gitignored — git cannot):
  `apps/worker/wrangler.jsonc:17` → `"2026-10-19"` (+ revert the §2.2 comment;
  the demo vars were never touched). Then `pnpm install` to re-resolve, and
  re-verify with §3.1's typecheck + a `pnpm test` pool check before any retry.
  Record the revert in the evidence block either way — a reverted window is a
  verdict, not a silence.

## Open issues carried into the window (informed consent, not blockers)

1. **The gate-release hazard (§1.5/§2.3):** after 2026-10-28 17:06/17:11Z a
   bare `pnpm up` resolves wrangler 4.154.0 / vitest-plugin 1.4.9 (miniflare
   pin `5.20261023.1-beta`), and after 10-29 01:08Z workers-types
   5.20261028.1. The exact-version commands make the window deterministic;
   the WAIT trio folds into the next natural refresh (census §4 Window 2
   recommends exactly this).
2. `check-delete-husk.mjs:131` hardcodes `compatibilityDate: "2026-10-19"` —
   runnable on the new workerd but four days behind `wrangler.jsonc`; the
   parity comment (`:129-130`) is temporarily false. One-line follow-up for
   the next engine-touching unit (not this window's ownership).
3. The bench-baseline item (§6) is conditioned on a GREEN public CI run,
   which did not exist at write time; if CI is still red at window open, §6
   waits for green (the item is "post-green" by definition) and the gate arms
   on the following run.
4. The demo TTL deep arm remains live-unexercised (deployed → `[info]` by
   design; the local arm needs `.dev.vars` with `DEMO_MODE="true"`). Same
   posture as RD24 — the mechanics are pinned by `demo-sweep.test.ts`; not a
   regression gate.
5. `pnpm -r outdated` is gate-filtered and under-reports by up to a day
   (census finding 1, `:168-171`) — any freshness claim made inside the
   window must cross-check registry dist-tags, never the outdated output.
6. The evidence conventions carried from RD24 (the JSONDecoder verdict scan,
   the PAT mint/shred discipline) are documented in `rd24-runbook.md` §§5.1/5.6
   and deliberately not duplicated here beyond the commands; keep that file
   open beside this one.

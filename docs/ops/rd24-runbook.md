# RD24 deploy runbook — the mechanical window script (pre-written)

Status: PRE-WRITTEN 2026-10-28 by the RD24-runbook unit (read-only; this file is
the unit's only deliverable). Every command/flag below was verified against the
tree at HEAD `bacfd7e` (A10-L, the batched `listTreeCommits` RPC, landed
2026-10-28 13:50 +0800). Steps that depend on an in-flight landing are marked
**(after X lands)** — do not execute them until the named unit is committed and
its gates are green. The orchestrator executes this top to bottom; each step
names its expected output and its failure branch. Never `git commit` inside the
window except the pre-agreed evidence appends, and only per the AGENTS.md
commit policy.

Conventions used below:

- PROD = `https://cf-gitea.hecongw.workers.dev` (the standing deployment;
  `docs/ops/runbook.md:190`).
- GO_COMMIT = the commit the orchestrator pins at window open (record it — the
  evidence template's first blank).
- Battery toolkit = `scripts/deploy-probes.mjs`; smoke = `scripts/deploy-smoke.mjs`.

## 1. Preconditions checklist (all must hold before opening the window)

1. **Pool drained.** Confirm all four carried units are LANDED and COMMITTED
   (`git log --oneline -15` + `git status --porcelain` empty):
   - **A10-L** — landed `bacfd7e` (verified at runbook-write time). Note: the
     query-shape audit's Landing Status table
     (`docs/research/query-shape-audit.md:22,245`) still reads "the L half
     stays open" — its A10-L row flip is a pending docs finalization (step 7),
     not a code dependency.
   - **assignee-fold** (the t2 assignee dedupe) — landed `98eb3f6`.
   - **M2** (banner + quotas) — **IN FLIGHT at runbook-write time** (uncommitted
     tree: `src/services/demo-quota.ts`, `src/ui/shell.tsx`, `demo-sweep.ts`
     edits + tests). **(after M2 lands)** — the window cannot open until these
     are committed; if M2 slips, RD24 goes without it and M2 rides RD24b
     (decide BEFORE opening; the evidence template's payload blanks flex).
   - **demo-posture battery (#12)** — **NOT in the toolkit at write time**
     (`BATTERY_NAMES`, `scripts/deploy-probes.mjs:210`, carries 11 + `all`;
     SPEC-0014 §7 defers it: `specs/0014-demo-ops.md:456-464`). Its run is
     **(after the demo battery lands)** — step 6.4. Its absence does NOT block
     RD24 core.
2. **Tree clean.** `git status --porcelain` → empty; `git -C gitea status
   --porcelain` → empty (submodule pristine; if `gitea/pnpm-lock.yaml` shows
   modified: `git -C gitea checkout --`).
3. **The sixth addendum's PENDING block is current.** Read
   `docs/RELEASE-NOTES-v1.2.md:735-750`: RD24 = migrations 0036 + 0037 applied
   remote (both index-only, the 65-table count stands), battery verdicts
   including the branch-protection battery (the toolkit's 11th, 18 arms),
   **`fw-org-member-preaccess` GREEN + which run FIRST recorded it**, the
   full-gate line at the final tree; A10-L and M2 finalize when their units
   land. Everything the block names must be executable from this runbook; if
   the block moved since write time, re-verify the delta against sections 4-5
   below.
4. **Ports and processes quiet** (the QUIET-WINDOW, per the e2e-sweep method,
   `docs/reviews/e2e-sweep-2026-10-28.md:53-57`): ports 5173/5199/8443 free;
   no dev servers, no sibling vitest/wrangler processes alive; no background
   agents mid-flight on the shared tree.
5. **Remote state sanity** (read-only): `wrangler d1 migrations list cf-gitea
   --remote` → pending exactly `0036_fantastic_whirlwind.sql` +
   `0037_smart_blizzard.sql` (output shape: one filename per line under the
   pending list; rd20-preflight precedent `docs/plans/rd20-wrap-preflight.md:86-88`).
   `wrangler secret list` shows `GIT_TOKEN`, `MIRROR_ALLOWED_HOST_LIST`,
   `MIRROR_CREDENTIAL_KEY` (uploaded at earlier deploys;
   `docs/design/p0-evidence.md:165-177`). If a secret is missing →
   `wrangler secret put <name>` BEFORE deploy (values never in source/config).

If any precondition fails → fix or re-scope before step 2; do not deploy from a
moving tree (the RD22 lesson: in-flight uncommitted hunks get bundled —
`docs/design/p0-evidence.md:928-938`).

## 2. The QUIET-WINDOW gate: the full-suite composite

```bash
CF_TEST_STRIP_SOURCEMAPS=1 pnpm test:full
```

(The env prefix is documentary — `pnpm test:full` already exports it:
`package.json:16`, `CF_TEST_STRIP_SOURCEMAPS=1 node scripts/full-suite-gate.mjs
--solo`.)

**The verdict protocol — ADR-0006, quoted semantics
(`docs/decisions/0006-full-suite-composite-gate.md:29-57,103-115`):**

1. **Phase 1 — one full run, exact attribution.** Every discovered file is
   attributed to exactly one of {ran, died-at-startup, failed-tests}; death
   attribution comes only from "Worker exited unexpectedly … while running test
   file" log lines; JSON stub entries (status "passed", zero assertions) never
   count as "ran"; unhandled errors must not exceed the attributed death count;
   a file absent from both results and deaths fails the gate.
   **"Assertion failures (and collection-time failures) are fatal and never
   retried away."**
2. **Phase 2 — `--solo` adjudication.** Every death/timeout file re-runs in its
   OWN vitest process (structurally immune to ws1009). **"A solo death is
   retried once, then fails honestly."** Timeout-class failures re-run;
   assertion failures fail immediately.
3. **"A green single-pass `vitest run` proves nothing about suite health at
   this scale"** — plain `pnpm test` is never cited as "full suite green"
   (ADR-0006 + AGENTS.md Commands). In strip mode phase 1 is single-pass again
   (≈174 s measured; deaths 204 → 0, ADR-0006:103-111); `--solo` remains the
   safety net for the residual heavy-closure contention class (one file per
   run, hook timeouts — not deaths).

**Gate: exit 0 and the phase-1 attribution line seen with your own eyes.**
Wall budget ~15-20 min worst case.

- If it fails with assertion failures → STOP, no deploy; the failure is real —
  route to the owning unit.
- If it fails with a solo-adjudicated death → one retry is built into the gate;
  a second death fails honestly → STOP, record the file, decide with the
  orchestrator.
- If it fails with the known 8-worker saturation class (5000 ms hook timeouts
  in `invariants.test.ts` / `pages-wave7.test.ts` that pass solo) → the gate's
  own solo phase adjudicates them; if the gate still exits non-zero, that is
  the verdict — no manual waiver.

### 2b. The two deferred harness re-verifications (from the e2e sweep)

Both run against a LOCAL dev server on the quiet tree. Start one:
`pnpm dev` (background; wait for `GET http://127.0.0.1:5173/healthz` → 200),
then:

1. **LFS relay suite** — `pnpm test:lfs` (= `bash scripts/lfs-e2e.sh`,
   `package.json:17`; default base `http://127.0.0.1:5173`,
   `scripts/lfs-e2e.sh:31,54`; starts its own server if none answers).
   Expected (the sweep's GREEN record, `e2e-sweep:154-173`):
   `=== RESULT: 33 passed, 0 failed ===`, exit 0, ~67 s, full cleanup.
   Failure branch: any red → STOP (LFS regression); check the dev server is
   the quiet tree's build, re-run once, then adjudicate by check id.
2. **Engine e2e allowlist set-equality** —
   ```bash
   PATH="$PWD/packages/git-engine/e2e/shim:$PATH" \
     packages/git-engine/e2e/e2e.sh http://127.0.0.1:5173/demo devtoken
   ```
   Expected steady state: `=== RESULT: 34 passed, 35 failed ===` (exit 1 by
   design). Then extract the failure set EXACTLY the way CI does
   (`.github/workflows/ci.yml:143`) and diff against the heredoc allowlist in
   the `e2e` job:
   ```bash
   grep '^FAIL:' /tmp/rd24-e2e.log | sed 's/ (got.*//' | sort > /tmp/observed.txt
   # diff /tmp/observed.txt against the ci.yml allowlist block — EMPTY DIFF = pass
   ```
   (the sweep's method verbatim, `e2e-sweep:60-63`; the 34/35 split is the
   documented score, `docs/ops/runbook.md:47-56`). Empty diff → GREEN.
   Failure branch: any failure OUTSIDE the allowlist (protocol core) → STOP —
   regression, no deploy. A 29/40-style excursion with stale-cell rejections
   (`fetch first`, `already exists`) is the environmental cascade
   (`e2e-sweep:74-125`): stop the server, remove the locked cell's SQLite file
   under `apps/worker/.wrangler/state/v3/do/cf-gitea-RepoCell/`, restart,
   re-run once. If it still diverges → treat as red.

Kill the dev server before continuing.

## 3. Resource prep — the repo-tasks DLQ must exist BEFORE deploy

The `repo-tasks` consumer declares `dead_letter_queue: repo-tasks-dlq`
(`apps/worker/wrangler.jsonc:150`) — **"the `repo-tasks-dlq` queue itself must
exist at deploy time — `wrangler queues create repo-tasks-dlq` if the platform
does not auto-provision consumer-declared queues"** (de486aa's deploy note,
`docs/ops/deploy-notes.md:60-64`). Run it BEFORE the first deploy of the
window:

```bash
wrangler queues list      # idempotent check first
wrangler queues create repo-tasks-dlq   # only if absent from the list
```

- Expected `queues list` content: `repo-tasks`, `webhook-delivery`,
  `webhook-delivery-dlq` at minimum (+ `repo-tasks-dlq` once created).
- If `create` fails "already exists" → fine, proceed (that is the idempotent
  path).
- If `create` fails for any other reason → STOP; a deploy whose consumer
  declares a missing DLQ risks the exact silent-drop the M0 closed.

## 4. The deploy

```bash
pnpm build && pnpm deploy
wrangler d1 migrations list cf-gitea --remote   # BEFORE apply: pending = 0036 + 0037
pnpm db:migrate:remote                          # = wrangler d1 migrations apply cf-gitea --remote
```

- `pnpm build` is REQUIRED before deploy — wrangler deploys `dist/`'s generated
  config; a stale dist carries the old wrangler state (the placeholder-id
  deploy failure, `docs/ops/runbook.md:183-187`). The `prebuild` hook runs
  `pnpm gen:icons` (`package.json:24`).
- Expected deploy output: a new Version ID (UUID) at 100% — **record it** plus
  the Worker startup time from healthz (evidence blanks). Confirm with
  `wrangler deployments list` (newest row "Created" moments ago at 100%).
- Expected migrate output: **`0036_fantastic_whirlwind` + `0037_smart_blizzard`
  in the applied list, both ✅**, then a re-run of
  `wrangler d1 migrations list cf-gitea --remote` → **"✅ No migrations to
  apply!"** (the established ledger shape; RD22 evidence
  `docs/design/p0-evidence.md:958-961`). **Paste both outputs** — the evidence
  template asks for them verbatim (`p0-evidence.md:3306-3308`).
- Order note: migrations may be applied before or after the deploy within the
  window; the standing practice applies them immediately before deploy. The
  window's only schema change is this pair; both are INDEX-ONLY (see §8).
- Failure branches:
  - Deploy fails on `database_id`/config drift → run
    `pnpm setup:deploy -- --check` (read-only drift probe,
    `docs/ops/deploy-notes.md:19`) and rebuild; never hand-edit `dist/`.
  - Migrate fails mid-apply → the `d1_migrations` ledger tracks exactly-once;
    fix the cause and re-run `pnpm db:migrate:remote` (it applies the
    remainder). Never hand-edit the ledger.
  - Deploy succeeds but healthz 5xx → rollback (§8) after one diagnosis pass
    (observability traces are on, `wrangler.jsonc.example:55-60`).

## 5. Post-deploy verification sequence

### 5.1 PAT minting discipline (verbatim — non-negotiable)

From `scripts/deploy-probes.README.md:50-64` and the standing evidence-block
rule:

- The token is **minted per run** by the operator:
  `node scripts/bootstrap-admin.mjs p0probe --remote` (the mint path —
  `scripts/bootstrap-admin.mjs:6-9`: creates the admin if missing, scope
  `all`, plaintext printed EXACTLY ONCE, only the sha256 digest stored).
- Capture stdout to a **0600 temp file**; **the raw mint stdout is shredded**
  (`rm -P`/`shred -u`).
- `--token-file` **enforces mode 0600** (a looser file is refused before any
  request) and the mint shape `cfg_<8hex>_<32base32>`.
- The token is **never echoed**: progress lines, details, and JSON summaries
  are scrubbed against it (and the `gitea_session` value ui-login captures).
- After the run the operator **DELETEs the per-run PAT** (by id/prefix) and
  re-checks with `cleanup-audit --expect-tokens 1` (the standing bootstrap
  PAT).
- Never pass `--token "$(cat ...)"` to deploy-probes (it takes `--token-file`
  only); the SMOKE takes `--token` inline, so expand it at runtime from the
  0600 file and keep the expansion out of any captured log line that echoes
  argv.

```bash
node scripts/bootstrap-admin.mjs p0probe --remote 2>/tmp/rd24-mint.err \
  | grep -oE 'cfg_[0-9a-f]{8}_[A-Z0-9]{32}' | head -1 > /tmp/rd24-pat.txt
chmod 600 /tmp/rd24-pat.txt /tmp/rd24-mint.err
grep -cE '^cfg_[0-9a-f]{8}_[A-Z0-9]{32}$' /tmp/rd24-pat.txt   # → 1 (exactly one full-shape line)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: token $(cat /tmp/rd24-pat.txt)" \
  $PROD/api/v1/user    # → 200 (authorization probe; the token transits only via $(cat ...))
```

The file must carry ONLY the token line: `--token-file` trims and validates the
WHOLE file against `cfg_<8hex>_<32base32>`, refusing anything else
(`scripts/deploy-probes.mjs` readTokenFile, the "[A-Z0-9] alphabet" lesson —
bootstrap's stdout is multi-line, so raw redirect will not validate; the
extraction class is a superset on purpose, the recorded `[A-Z2-7]` empty-token
incident is `docs/design/p0-evidence.md:768-772`). Shred BOTH temp files
(`shred -u /tmp/rd24-pat.txt /tmp/rd24-mint.err`) at wrap.

### 5.2 `pnpm smoke` (flags)

```bash
pnpm smoke -- --base-url $PROD --user p0probe --migrate-check \
  --token "$(cat /tmp/rd24-pat.txt)"
```

(Flags verified `scripts/deploy-smoke.mjs:106-107`: `--base-url` required,
`--token <PAT>`, `--user <name>`, `--migrate-check`, `--bench-report`,
`--timeout-ms`, `--json`.)

Expected: **6 pass / 0 fail / 1 skip** (bench-report not requested), `ok:
true` — healthz, anon-git-surface, receive-advert, push-lsremote, cleanup,
migrate-check. The migrate-check line expects the standing table census **unchanged
by 0036+0037** (both index-only — no new tables; "the 65-table count stands",
sixth addendum `docs/RELEASE-NOTES-v1.2.md:747-748`) plus **"No migrations to
apply"** (the RD24 template's expectation, `p0-evidence.md:3342-3343`). The
cleanup line must show the smoke repo deleted.

Failure branch: a `push-lsremote` red → re-run once (settle-window class is
fixed, so a red is real); a `migrate-check` mismatch → compare the table list
against the migration files, STOP on any missing table.

### 5.3 The battery runs

One shared invocation shape (`scripts/deploy-probes.README.md:13-15`):

```bash
node scripts/deploy-probes.mjs <battery> \
  --base-url $PROD --token-file /tmp/rd24-pat.txt
```

Run, in this order (audit last):

1. **The standing nine** — census **113 checks** (wave-131 ledger §1,
   `docs/reviews/wave-131-landing-ledger.md:47-51`, derived from the committed
   `id:` census): `p0` 4 · `registry` 21 (`--trials` default 3, 7 arms × 3) ·
   `generate-e2e` 10 · `forkpr-e2e` 8 · `mirror` 8 · `ui-login` 5 ·
   `window2-mounts` 22 · `window3-mounts` 25 · `cleanup-audit` 10. Expected:
   all green (the cleanup-audit's `audit-personal-access-tokens` arm may
   report the live run-PAT — the standing instrument item, deleted at wrap
   close in 5.7).
2. **fixwave-parity** (the 10th battery, 22 checks, `independent: true` — a red
   family never chain-skips the rest). Needs an **ADMIN PAT** (`--user` must
   be the site admin) and **wrangler auth for the D1 arms** (`--d1-scope
   remote` is the default — keep it in step with `--base-url`).
   Expected: **22/22 green — this deploy is its first formal post-deploy
   verdict run.**
3. **branch-protection** (the 11th battery) — **18 checks** verified from the
   committed census (`id: "bp-…"`, 18 entries at
   `scripts/deploy-probes.mjs:3002-3347`, incl. `bp-slash-glob-wildcard:3314`
   from `bd59bc4` and `bp-merge-blocked-405:3181`; `e9f37f2` shipped 17,
   `bd59bc4` added the slash-glob arm — the sixth addendum's "18 arms",
   `docs/RELEASE-NOTES-v1.2.md:739-742`; note the evidence template's stray
   "17" at `p0-evidence.md:3332` is stale — write 18). ADMIN PAT, no D1 scope
   coupling (the priority op reads rule ids off the API render, README:329-334).
   Expected: 18/18 green.
4. **demo-posture battery (#12)** — **(after the demo battery lands AND the
   demo flip §6 is armed)**; it does not exist in `BATTERY_NAMES` at write
   time (`scripts/deploy-probes.mjs:210`). When it lands it runs per SPEC-0014
   §7 (`specs/0014-demo-ops.md:456-464`): arm the gate, backdate a repo's
   `created_at` via wrangler d1 (the second D1-write arm after fixwave's
   rotation backdate), tick the producer path, assert the delete + banner,
   then a gate-off pass asserting nothing schedules.

Verdict expectations to paste per battery: the `[pass] <id> (<ms> ms) —
<detail>` lines (the shape the evidence blocks quote, README:5-8) + each
battery's final JSON summary.

Failure branch (any battery): the battery **self-cleans on a red** — the
`[tail] <battery>-leftover-sweep` line lists exactly what was swept
(README:360-394); read it, then run `cleanup-audit` — the audit going green is
the sweep's proof (README:435-436). Adjudicate the red against the README's
canonical expectation for that check id; a genuine product red → STOP the
evidence block for that arm, record `left_behind` count, decide fix-forward vs
rollback (§8).

### 5.4 THE DEPLOY DISCRIMINATOR — `fw-org-member-preaccess` GREEN

The fixwave-parity org-grant arm (`id: "fw-org-member-preaccess"`,
`scripts/deploy-probes.mjs:2664`) read **red in RD23's standing smoke (the
20/1)** because row-19's git grant rode the next deploy; **its green at this
deploy's formal run is THE verdict arm** (sixth addendum
`docs/RELEASE-NOTES-v1.2.md:742-746`; the RD23 block
`docs/design/p0-evidence.md:3287-3295`).

**The evidence block must state WHICH RUN FIRST recorded the arm green** (the
wave-131 ledger's flagged §6 tension,
`docs/reviews/wave-131-landing-ledger.md:108-118`: RD23's 112/1 reconciles
with the nine standing batteries only, so absent an orchestrator record saying
otherwise, RD24's formal post-deploy run is the first formal green — write
that sentence with the run's timestamp).

Failure branch: the arm red at RD24 → the org-grant code did not reach
production. Check `wrangler deployments list` (is the live version the one
just deployed?), confirm the carrying commit is in the GO tree
(`git branch --contains` / `git log GO_COMMIT --oneline | grep …`), then
fix-forward; do NOT write the discriminator line as green.

### 5.5 Force-red rehearsal (the committed arm)

The branch-protection battery ships a committed force-red arm —
`bp-merge-blocked-405` (template expectation, `p0-evidence.md:3340-3341`):

```bash
node scripts/deploy-probes.mjs branch-protection --force-red bp-merge-blocked-405 \
  --base-url $PROD --token-file /tmp/rd24-pat.txt
```

Expected (README:417-420): fail=1 with `FORCED RED (--force-red
bp-merge-blocked-405)`, siblings `[skip]`, and the
`[tail] bp-leftover-sweep` line listing BOTH rule deletes then the repo
delete (the member arm has not run — nothing else to sweep). Then:

```bash
node scripts/deploy-probes.mjs cleanup-audit --d1-scope remote   # must go green
```

A green audit right after the forced red is the sweep's proof (the rehearsal
convention, README:435-436). Paste both into the template's Force-red blank.
Failure branch: the tail lists fewer deletes than created → a `[warn]` +
`left_behind` in the summary; hand-delete the named residue, re-run
cleanup-audit, and record the deviation.

### 5.6 Verdict parsing — the multi-object JSONDecoder scan

The batteries emit per-check progress lines on stderr and ONE final JSON
summary object per invocation; captures concatenate MULTIPLE JSON objects (one
per battery run) in one stream. Parse them with a raw_decode LOOP — not
`json.load`, which throws on concatenated objects:

```python
import json
dec = json.JSONDecoder(); pos = 0; objs = []
s = open("/tmp/rd24-verbose.log", encoding="utf-8", errors="replace").read()
while True:
    while pos < len(s) and s[pos] in " \t\r\n":
        pos += 1
    if pos >= len(s):
        break
    obj, pos = dec.raw_decode(s, pos)
    objs.append(obj)
```

Take each object's `battery`/`ok`/`results` fields; the per-battery verdict
for the evidence block is the LAST object of its run. Scan every parsed object
for any `status != "pass"` entry before declaring a battery green — the
summary counts alone have masked a red before (the AGENTS.md "own eyes" rule,
pre-commit checklist item 1). NOTE: this parser is the orchestrator's
evidence-workflow convention, NOT an in-tree artifact — nothing under
`scripts/` implements it (verified by grep); the contract it relies on
(progress→stderr, summary→stdout, one JSON object per run,
`--json` = summary-only on stdout) IS in-tree (README:47-48,
`deploy-smoke.mjs:109-110`).

### 5.7 Cleanup audit + PAT teardown (the wrap)

```bash
node scripts/deploy-probes.mjs cleanup-audit --d1-scope remote
```

Defaults are the production expectations (`scripts/deploy-probes.mjs:234,260`):
`--user p0probe`, `--expect-owner-repos 1` (the standing `p0-shallow`
fixture), `--expect-tokens 1` (the standing bootstrap PAT). Expected green:
`status='creating'` == 0 · `action` == 0 · `stars` == 0 · `push_mirrors` == 0 ·
`protected_branches` == 0 · `repo_redirects` == 0 · `user_blocking` == 0 ·
`personal_access_tokens` == 1 · probe-user repositories == 1 (README:342-352).

Then the PAT teardown: DELETE the per-run PAT (by id/prefix; the mint shape
gives the prefix `cfg_<8hex>`), shred the 0600 temp files (the PAT file + the
mint stderr capture, §5.1), re-run
`cleanup-audit --d1-scope remote` → still green with tokens == 1. **Paste:
"every battery self-cleaned … the run PAT deleted at wrap close,
`personal_access_tokens` back to the standing bootstrap = 1"** (the template's
expected shape, `p0-evidence.md:3345-3348`).

## 6. The demo flip (RD24b, or the same window after §5 closes)

The flip is a var/route edit in the REAL, gitignored
`apps/worker/wrangler.jsonc` + redeploy. Current real-config state (read
2026-10-28): `APP_URL = https://cf-gitea.hecongw.workers.dev`, `DEMO_MODE:
"false"`, **no `ALLOW_SIGNUP` var, no `routes`/`custom_domains` entry** — it
serves workers.dev only. The example template carries both vars
(`apps/worker/wrangler.jsonc.example:45,53`); the real config predates
ALLOW_SIGNUP and must gain it.

SPEC-0014 §1 posture being armed (`specs/0014-demo-ops.md:30-52`): a public
display-purpose instance at `cf-gitea-demo.aiapp.run`, periodically cleaned,
open signup (OQ-1 RESOLVED by convergence: the registration surface is the
`ALLOW_SIGNUP`-gated signup, "the demo enables the var, self-host defaults
keep it off" — `docs/RELEASE-NOTES-v1.2.md:3-10`).

1. Edit `apps/worker/wrangler.jsonc` (gitignored — the tree stays clean):
   - `"ALLOW_SIGNUP": "true"` (absent-safe FALSE without it —
     `docs/ops/deploy-notes.md:65-70`);
   - `"DEMO_MODE": "true"` — the EXACT string `"true"` arms the sweep; any
     other value is fail-closed OFF (§6.8, `specs/0014-demo-ops.md:420`);
   - `"APP_URL": "https://cf-gitea-demo.aiapp.run"` (the pre-publish scan's
     agreed remediation, `docs/reviews/pre-publish-scan-2026-10-28.md:131-134`);
   - **the route entry**: the current config supports NEITHER form today, so
     add the custom-domain object form (workers config):
     `"routes": [{ "pattern": "cf-gitea-demo.aiapp.run", "custom_domain":
     true }]`. The `routes` array string form (`"routes":
     ["cf-gitea-demo.aiapp.run"]`) also exists but is zone-pattern scoped;
     `custom_domain: true` provisions the binding + cert directly and is the
     form to prefer. **Execution-time check:** the `aiapp.run` zone must be in
     this Cloudflare account — if `wrangler deploy` rejects the route
     ("zone not found"/"not owned"), attach the custom domain via the
     dashboard instead and keep the config workers.dev-only; record which
     path was used in the evidence.
   - The hourly sweep producer tick `"0 * * * *"` is ALREADY in
     `triggers.crons` (`wrangler.jsonc:125`) and no-ops while the gate is off
     — no cron edit needed.
2. `wrangler types` (the declared-vars discipline — declared vars are typed
   required, `specs/0014-demo-ops.md:84-87`), then `pnpm --filter
   cf-gitea-worker typecheck` (0 errors).
3. **(after M2 lands)** the banner + quota arms are observable; if M2 has not
   landed, the flip still works (M1's gate+sweep are landed, `5c59f1f` +
   `15e2b62`) but the battery's banner/quota arms are absent — schedule the
   battery for RD24b.
4. Redeploy: `pnpm build && pnpm deploy` (new version ID — record it as the
   demo posture's version). First sweep tick: expect the `[demo-sweep]
   enqueued N of M eligible` log line (or the compact 0-eligible one-liner)
   in observability within the next :00 hour — every sweep batch logs counts
   (`specs/0014-demo-ops.md:216-219`).
5. Live checks (hand spots): `GET https://cf-gitea-demo.aiapp.run/healthz` →
   200; anonymous signup page reachable (`ALLOW_SIGNUP` arm); a fresh
   non-admin repo created older than 72 h sweeps within its hour (§6.4: the
   first ticks drain the backlog at ≤ 50/h; admin-owned fixtures survive).
6. **The demo battery (#12)** — **(after the demo battery lands)**: run per
   SPEC-0014 §7 against the flipped instance, then the gate-off pass.

Failure branches: `DEMO_MODE` typo'd to anything ≠ `"true"` → the sweep
silently never runs (§6.8) — symptom is the MISSING hourly log line; fix the
value, redeploy. Route 522/SSL errors → the custom-domain cert is still
provisioning; retry after a few minutes before diagnosing further.

## 7. Evidence, finalizations, publish

### 7.1 Paste points — the RD24 template's `__BLANK__` fields, in order

`docs/design/p0-evidence.md:3305-3348` — fill top to bottom:

1. Header: TIME · GO commit · deploy version · healthz 200 @ Ns · the
   0036+0037 apply/list output (verbatim from §4).
2. Payload per-commit lines: perf wave `b04a465` + `7dc607f` + `c614daa` +
   `fbd0826` + `7c3b7c47`; engine D3 `6545edd`; then the four
   in-flight-at-draft blanks — mirror-HEAD (landed `071f10b` — fill it),
   wiki-webhook (`__BLANK__` **(after that unit lands)**), tier-2 adoption
   (`__BLANK__` **(after that unit lands)**), the addressability fix (landed
   `bd59bc4` — fill it). Verify each hash with `git log` at GO; never paste a
   hash you have not seen in the log.
3. The gate at GO: `pnpm test:full` (the §2 verdict line) · `pnpm typecheck` ·
   `pnpm lint` · `check-openapi` (`pnpm check:api`; documented warns GET /user
   401 + GET /signing-key.gpg/.pub 404 stand).
4. Battery verdict: the per-battery paste (§5.3) — the total changes at this
   deploy: 113 standing + 22 fixwave + **18** branch-protection.
5. THE DISCRIMINATOR: the `fw-org-member-preaccess` verdict + which run FIRST
   recorded it green (§5.4's sentence).
6. Force-red: the §5.5 paste.
7. `pnpm smoke (--migrate-check)`: the §5.2 line.
8. Hand spots: anything probed by hand (e.g. the §6 live checks).
9. Cleanup audit / PAT-audit: the §5.7 line.

### 7.2 The PENDING finalizations

1. **The sixth addendum's PENDING block**
   (`docs/RELEASE-NOTES-v1.2.md:735-750`): rewrite as the final RD24 record —
   deploy version, healthz, 0036+0037 applied remote, battery verdicts incl.
   branch-protection (11th, 18 arms), `fw-org-member-preaccess` GREEN + the
   first-green run, the full-gate line at the final tree. Its "A10-L and M2
   finalize when their units land" splits: A10-L finalizes NOW (landed
   `bacfd7e`); M2 stays PENDING **(after M2 lands)** unless it made this
   window.
2. **The audit's A10-L row**: `docs/research/query-shape-audit.md` Landing
   Status table (`:22`) + §A10 (`:245`) still read "the L half stays open" —
   flip to LANDED `bacfd7e` (the batched `listTreeCommits` RPC) in the same
   docs batch.
3. **M2's SPEC-0014 §8 row** (`specs/0014-demo-ops.md:478`): mark M2 LANDED
   **(after M2 lands)** with its commit(s).

### 7.3 The publish (gh) steps

No publish commands exist in-tree (verified — grep across `docs/` + repo
root); this is the standard flow, with the fresh-clone proof's method as the
acceptance gate:

```bash
gh repo create <owner>/cf-gitea --public --source=. --remote=origin --push
```

- `--public` (the release wave's stated goal), `--source=.` (this checkout),
  `--push` (pushes the default branch). The graduation guarantees the push
  carries no account-local files: `wrangler.jsonc` + `.dev.vars` are
  gitignored; only the `.example` templates ship (fresh-clone proof §7,
  `docs/reviews/fresh-clone-proof-2026-10-28.md:154-170`). The repo has NO
  origin at write time (verified: `git remote -v` empty) — `gh repo create`
  adds it.
- **Submodule fetchability check — the fresh-clone proof's method
  (`docs/reviews/fresh-clone-proof-2026-10-28.md:36-65`):**
  ```bash
  git clone --recurse-submodules <published-url> /tmp/rd24-publish-proof
  ```
  PASS = the `gitea/` submodule fetches from its recorded URL
  (`https://github.com/go-gitea/gitea`), checks out exactly the pin
  `fc4936884584a41931906553d96c2601d750e6ef` (verified via
  `git submodule status`), lands clean, and BOTH `git status --porcelain`s
  (clone root + submodule) are empty; scratch deleted after.
  Known environmental branch: the first submodule fetch can die mid-stream
  (curl 92 / HTTP/2 CANCEL) and git's per-submodule retry recovers — re-run
  `git submodule update --init --recursive` once before calling it a failure
  (proof findings 1-3 + the deviation ledger).
- Known papercut, already remediated in-tree: bare `pnpm typecheck` on a fresh
  clone works first-try (the root `pretypecheck` hook, proof's decision
  record, `fresh-clone-proof:201-203`).
- If publish hits the history question again: it is SETTLED — the
  orchestrator's acceptance decision (the committed `database_id` rides
  history by doctrine; ACCEPTED, `fresh-clone-proof:189-199`). Do not reopen.

## 8. Rollback

```bash
wrangler deployments list        # read the version IDs + Created timestamps; the live row is 100%
wrangler rollback <version-id>   # the PRE-RD24 version id from the list (omit the id only if prompted interactively)
```

(The version-id source is the standing convention — every evidence block reads
`wrangler deployments list`; e.g. `docs/design/p0-evidence.md:1239`.)

- After rollback, re-run §5.2 smoke (expect green — the pre-RD24 version was
  green) and re-run `fixwave-parity`: **`fw-org-member-preaccess` is EXPECTED
  RED again on the rolled-back version** (the arm tracks the deploy — its red
  there is the discriminator working, not a regression). Record the rollback +
  the arm's red honestly in the evidence block; the first-green-run sentence
  (§5.4) then reads "green at RD24's run; red again after the rollback".

**D1 migration irreversibility — stated explicitly: D1 migrations are
apply-only (the `d1_migrations` ledger has no down-path; `wrangler d1
migrations` never reverts), and BOTH RD24 migrations are INDEX-ONLY, so they
are SAFE TO LEAVE APPLIED ON ROLLBACK:**

- `0036_fantastic_whirlwind` (`apps/worker/src/db/migrations/0036_fantastic_whirlwind.sql`)
  = **10 × `CREATE INDEX`** and nothing else (labels repo/org pair,
  `issues` list filter+order composite + poster heatmap COVERING, reactions
  target composite, milestones, `repositories.owner_id`, the action repo-feed
  order, `issue_subscriptions` issue-side, `comments` poster composite).
- `0037_smart_blizzard` (`apps/worker/src/db/migrations/0037_smart_blizzard.sql`)
  = **9 × `DROP INDEX` + 8 × `CREATE INDEX`** and nothing else (verified: the
  file's 17 statements are all index DDL; no `CREATE TABLE`, no `ALTER`, no
  data migration).
- Indexes are invisible to application correctness — an old worker version
  running against a newer index set only sees query-plan differences (the new
  indexes make old-code reads faster or unchanged; the dropped indexes were
  verified dead by the 15-shape plans-UNCHANGED proof, sixth addendum
  `docs/RELEASE-NOTES-v1.2.md:610-617`). **Do NOT hand-revert the migration
  files or touch `d1_migrations`;** a re-apply after a fix-forward is a no-op,
  and the 65-table count stands across both rollback and fix-forward paths
  (index DDL never creates tables).
- If a FUTURE window ships a non-index (data/DDL-destroying) migration, this
  section's safe-on-rollback claim dies with it — the next runbook must
  re-derive it per migration file.

## Open issues carried into the window (informed consent, not blockers)

1. The demo-posture battery (#12) does not exist yet — SPEC-0014 §7 defers it;
   its run is post-landing (§5.3 item 4 / §6.6).
2. The evidence template's branch-protection count reads "17" at
   `p0-evidence.md:3332` vs the census's 18 (`scripts/deploy-probes.mjs`
   bp-`id:` entries) — write 18, note the template line is stale.
3. The verdict-parsing convention (§5.6) is not implemented in-tree; it is
   recorded here so the window does not depend on tribal memory.
4. The custom-domain route form (§6.1) could not be verified against the
   account (config has never carried a route); the dashboard fallback is
   written into the failure branch.
5. The `wrangler rollback` flag surface is standard wrangler v4 CLI (no
   in-tree usage precedent beyond reading `deployments list`); if the pinned
   wrangler 4.152.0 changes the invocation, `wrangler rollback --help` governs.

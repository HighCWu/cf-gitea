# v1.3.1 tag runbook — the ordered tail-chain

Status: PRE-WRITTEN 2026-10-30 (docs-only). Executor: the orchestrator, top to
bottom; agents never `git commit` (AGENTS.md Commit Policy). Every command was
verified against the tree at HEAD `48d4929`; each step names its source. Shape
follows the RD25 runbook precedent (`docs/ops/rd25-runbook.md`).

Conventions:

- PROD = `https://cf-gitea.hecongw.workers.dev` (`docs/ops/runbook.md:190`).
- FREEZE_HEAD = the last commit at cut time (§6); TAG_COMMIT = the notes-fill
  commit the tag rides (§6-§7). Temp files: `/tmp/v131-pat.txt`,
  `/tmp/v131-mint.err` (0600 throughout, §5).
- The v1.3.1 range base is `fe6d1a8` (the v1.3 tag's commit;
  `docs/RELEASE-NOTES-v1.3.1.md:5`).

## Pre-flight — all must hold before step 1

> - [ ] **CI green**: `gh run list --repo HighCWu/cf-gitea --limit 3` — newest
>       runs green (the 9:00 convergence prompt (b),
>       `docs/run-pending-9am-task.md:89`; contract exception ledger
>       `scripts/check-openapi.mjs` `RUNTIME_ONLY_RESPONSES`).
> - [ ] **Gate green**: §1 has already exited 0 with the phase-1 attribution
>       line seen with your own eyes (ADR-0006; never pattern-match a claim).
> - [ ] **Tree clean**: `git status --porcelain` → empty AND
>       `git -C gitea status --porcelain` → empty (if `gitea/pnpm-lock.yaml`
>       shows modified: `git -C gitea checkout --`) (RD25 §1,
>       `docs/ops/rd25-runbook.md:28-35`).
> - [ ] **All units landed**: the residuals board's in-flight block
>       (`docs/residuals-v1.3.2.md` header) is resolved — every named sibling is
>       a committed ancestor of HEAD; no background agent is mid-flight on the
>       tree (the quiet-window definition, RD25 §1).

## 1. The composite gate

```bash
pnpm test:full    # = CF_TEST_STRIP_SOURCEMAPS=1 node scripts/full-suite-gate.mjs --solo (package.json:16)
```

Gate: **exit 0 and the phase-1 attribution line seen with your own eyes**;
wall budget ~15-20 min worst case (strip-mode phase 1 is single-pass ≈174 s;
`--solo` adjudicates the residual contention class). Verdict semantics are
ADR-0006's and are never waived: assertion failures are fatal; a solo death
fails honestly after one built-in retry; a green single-pass `vitest run`
proves nothing at this scale. Full protocol: `docs/decisions/0006-full-suite-composite-gate.md`
(§29-57, §103-115) and the quoted shape in `docs/ops/rd24-runbook.md:80-113`.
The convergence prompt makes it the hard precondition:
`docs/run-pending-9am-task.md:89` ((a) "the whole-tree composite gate …
must be green").

## 2. Remote migration — 0044 + 0045 (0045 is NEW this wave)

```bash
pnpm exec wrangler d1 migrations list cf-gitea --remote   # from apps/worker; BEFORE apply
pnpm db:migrate:remote                                    # = wrangler d1 migrations apply cf-gitea --remote
pnpm exec wrangler d1 migrations list cf-gitea --remote   # re-list → "No migrations to apply!"
```

Expected pending at cut time: **`0044_peaceful_ronan` (cron_state) +
`0045_gigantic_retro_girl` (lfs_locks)** — both landed after the v1.3 tag
(`64ebfa9`, `7b589c7`; verified `git merge-base --is-ancestor`), and v1.3's
deploy applied only 0041+0042+0043 (`docs/run-pending-9am-task.md:29`). The
v1.3.1 notes' §8 names only 0044 — its doc-time snapshot predates 0045; sync
that line in §6. Whatever the list shows IS the apply set — re-verify with
your own eyes before applying. Migration runs BEFORE deploy (the 9:00 prompt:
`docs/run-pending-9am-task.md:89` ((c)); order note and failure branches —
mid-apply re-run applies the remainder, never hand-edit the `d1_migrations`
ledger — are RD24 §4, `docs/ops/rd24-runbook.md:177-203`).

## 3. The deploy build

**First preference — main tree clean at final HEAD (it is, per pre-flight):**

```bash
pnpm build        # root; = pnpm --filter cf-gitea-worker build; prebuild gen:icons reads gitea/
```

**Fallback — in-flight files appeared: build in a worktree.** The verified
copy-list (`docs/run-pending-9am-task.md:73-86`, the 07:15 GO verdict; the
durable recipe `docs/ops/runbook.md:202-229`): (1) `git worktree add <dir> HEAD
--detach`; (2) wire node_modules per `wireNodeModules`
(`scripts/verify-commit.mjs:231`) — never `pnpm install`; (3) **symlink
`gitea/` → the main tree's checkout — REQUIRED** (a fresh worktree's submodule
dir is empty and the build dies at prebuild `gen:icons`); (4) copy from main:
`apps/worker/public/assets/` (the 784-file official bundle, gitignored),
`apps/worker/wrangler.jsonc` (**copy, never edit** — account-local,
gitignored), `apps/worker/src/ui/icons.generated.ts` (optional when prebuild
runs); (5) build from the worktree. `worker-configuration.d.ts` is NOT needed.

**Post-build checks** (`docs/ops/runbook.md:230-261`, rehearsal-verified
2026-10-30): manifest `dist/client/assets/.vite/manifest.json` carries all 4
`REQUIRED_MANIFEST_KEYS` (a miss is a 503 at request time, not a build
failure); `dist/client/assets/` is the 784-file byte-parity bundle class.
Then eyeball the var table the deploy will ship — expected-benign warnings:
`rules` ignored under Vite + the missing-secrets trio
(`docs/ops/runbook.md:253-260`):

```bash
cd apps/worker && pnpm exec wrangler deploy --dry-run   # re-eyeball the var table
```

Expected vars/routes on the dry-run and on the real deploy output (the
rehearsal GO verdict, `docs/run-pending-9am-task.md:64-71`): real D1 id (NOT
the placeholder), `DEMO_MODE "true"` + `ALLOW_SIGNUP "true"` preserved, the
custom-domain route + `workers_dev`, `cpu_ms 300000`, both DLQ consumers,
observability + traces. **Build is REQUIRED before deploy and is the LAST
action before it** — wrangler deploys `dist/`'s generated config; a stale dist
caused the placeholder-database_id deploy failure (AGENTS.md Deploy
Discipline; `docs/ops/runbook.md:183-187`). At ≈2 s/build, rebuild at final
HEAD rather than trust a stale dist.

## 4. wrangler deploy

```bash
pnpm deploy                 # = wrangler deploy from apps/worker, off the fresh dist
wrangler deployments list   # newest row "Created" moments ago at 100% — RECORD the Version ID
curl -s -o /dev/null -w "%{http_code}\n" $PROD/healthz        # → 200
curl -s -o /dev/null -w "%{http_code}\n" https://cf-gitea-demo.aiapp.run/healthz  # → 200
```

Record the Version ID (the RD23/RD24 lineage convention,
`docs/ops/rd24-runbook.md:185-187`; healthz on BOTH surfaces,
`docs/ops/rd25-runbook.md:288-295` — a DEMO 522/SSL error is cert
re-provisioning, retry after a few minutes). Deploy output's var table must
match §3's dry-run; drift → `pnpm setup:deploy -- --check` (read-only,
`docs/ops/deploy-notes.md:19`), rebuild, never hand-edit `dist/`.

## 5. The probe battery — all 14, PAT discipline, teardown

Mint the per-run PAT (the standing discipline, verbatim:
`docs/ops/rd24-runbook.md:210-247` + `scripts/deploy-probes.README.md`
"PAT conventions"; the mint prints the plaintext EXACTLY ONCE,
`scripts/bootstrap-admin.mjs:6-9`; `p0probe` is the `<username>` argument and
the toolkit's `--user` default, `deploy-probes.mjs:295`):

```bash
node scripts/bootstrap-admin.mjs p0probe --remote 2>/tmp/v131-mint.err \
  | grep -oE 'cfg_[0-9a-f]{8}_[A-Z0-9]{32}' | head -1 > /tmp/v131-pat.txt
chmod 600 /tmp/v131-pat.txt /tmp/v131-mint.err
grep -cE '^cfg_[0-9a-f]{8}_[A-Z0-9]{32}$' /tmp/v131-pat.txt   # → 1 (the whole file must be ONE token line)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: token $(cat /tmp/v131-pat.txt)" \
  $PROD/api/v1/user    # → 200
```

Run the full battery — `all` = every battery in registry order, cleanup-audit
last (`deploy-probes.mjs:195`, `BATTERY_NAMES` at `:296`; 14 batteries / 176
probes, `scripts/deploy-probes.README.md:74-94`; the 9:00 prompt (d),
`docs/run-pending-9am-task.md:89`):

```bash
node scripts/deploy-probes.mjs all --base-url $PROD --token-file /tmp/v131-pat.txt
```

Gate: every check green — exit code is non-zero iff any check FAILS (warn and
`[info]` never fail; `deploy-probes.mjs:204-206`). Two documented non-failures:
`demo-ttl-mechanics` records the ops-note `[info]` on a deployed target
(`deploy-probes.mjs:3783-3788`), and `demo-config-posture` PASSES on this
operator machine post the 2026-10-29 revision — the live config's
`DEMO_MODE "true"` is legal WITH the cf-gitea-demo route
(`deploy-probes.mjs:3711-3727`). Never pass `--token`; `--token-file` only
(0600 enforced; token never echoed — scrubbed from every line).

**Teardown (the standing hygiene):** delete the per-run PAT row (by prefix =
the mint's `cfg_<8hex>`), shred both temp files, then the audit:

```bash
cd apps/worker && pnpm exec wrangler d1 execute cf-gitea --remote \
  --command "DELETE FROM personal_access_tokens WHERE prefix = 'cfg_<8hex from the mint>'"
```

```bash
shred -u /tmp/v131-pat.txt /tmp/v131-mint.err
node scripts/deploy-probes.mjs cleanup-audit --d1-scope remote   # from the repo root
```

Green = owner_repos == 1 (the standing p0-shallow fixture) + the eight
zero-count tables + **tokens == 2 — the DEFAULT** (one standing bootstrap PAT
per standing user, admin + p0probe; `deploy-probes.mjs:321,4678-4684`). Red
items adjudicate per the 9:00 prompt: real bug → fix; environmental noise →
re-run with evidence; expired → check — change the disposition with the
evidence attached (`docs/run-pending-9am-task.md:89`).

## 6. The notes' TBD fill + commit

Fill `docs/RELEASE-NOTES-v1.3.1.md:3` — the two placeholders:

```bash
git rev-list fe6d1a8..HEAD --count        # FINAL_COUNT (the freeze numbers)
git rev-parse HEAD                        # FREEZE_HEAD → FINAL_HEAD
```

- `fe6d1a8..FINAL_HEAD_TBD` → `fe6d1a8..<FREEZE_HEAD>`; `FINAL_COUNT_TBD` →
  the rev-list count. Precedent shape: v1.3's notes named the freeze HEAD
  `4a45370` and the fill commit `fe6d1a8` rode on top and was tagged
  (`docs/RELEASE-NOTES-v1.3.md:3-7`; `git log -1 v1.3`).
- Honesty syncs in the same edit: §8's "One new migration: 0044" → 0044 + 0045
  (0045 `lfs_locks` landed post-snapshot, `7b589c7`).

Commit (orchestrator, pathspec, docs-only):

```bash
git add docs/RELEASE-NOTES-v1.3.1.md
git commit -m "docs(release): the v1.3.1 final-window fills — the freeze numbers (<FINAL_COUNT> commits, fe6d1a8..<FREEZE_HEAD>)" \
  -- docs/RELEASE-NOTES-v1.3.1.md
git show --stat HEAD    # only that one path landed
```

TAG_COMMIT = this commit (the tag target in §7, matching the v1.3 precedent).

## 7. git tag v1.3.1 + push + gh release create

```bash
git push origin main
git tag -a v1.3.1 -m "v1.3.1" && git push origin v1.3.1
gh release create v1.3.1 --title "v1.3.1" --notes-file docs/RELEASE-NOTES-v1.3.1.md
```

Command shape is the v1.3 precedent (`docs/run-pending-9am-task.md:89` (f)):
`git tag && git push origin <tag> && gh release create <tag> --title <tag>
--notes-file docs/RELEASE-NOTES-<tag>.md`. The `-a` is deliberate — v1.3
landed as an ANNOTATED tag object (`git cat-file -t v1.3` → `tag`), so v1.3.1
matches; the release row should read title `v1.3.1`, tag `v1.3.1` (v1.3's row:
`gh release list`).

## 8. The post-tag residuals tick

Update `docs/residuals-v1.3.2.md` per its own conventions (header update lines
stamp a snapshot sha; "How to consume" requires verifying the in-flight block
before anything dispatches; `docs/residuals-v1.3.2.md:22-45,492-511`):

- Stamp a header line **"Updated at the v1.3.1 tag `<TAG_COMMIT>`"** and fold
  the in-flight block: the three named siblings are landed at this writing —
  the model.ts cite renumbers `48d4929`, the E9 deferral `d2fd6f0`, the
  archive POST-arm pins `e9a6595` (verify each with `git log` before writing
  "landed") — and any tag-day strays are recorded as new rows, not silence.
- The P1-P3 ranges are the v1.4 intake; the release notes' §9 already points
  here (`docs/RELEASE-NOTES-v1.3.1.md:267-276`).
- Keep P3-9's dated watch visible: the Oct 31 11:00 UTC sweep-fire observation
  (D1 orphan action rows stay 0) + upstream filings #16548/#16349
  (`docs/residuals-v1.3.2.md:421-432`; `docs/run-pending-9am-task.md:89` (4)).

Commit docs-only via pathspec (`-- docs/residuals-v1.3.2.md`). This tick lands
AFTER the tag by design — the tag carries the freeze, the board carries the
future.

## Stale precedent texts — do not follow

- `docs/ops/rd25-runbook.md:384-392` ("demo-config-posture REDS BY DESIGN on
  this machine") — superseded by the 2026-10-29 arm revision: legal with the
  demo route (`deploy-probes.mjs:3711-3727`).
- `docs/ops/rd24-runbook.md:224-226` / `rd25-runbook.md:427-435`
  (`--expect-tokens 1`) — superseded: the default is 2 since the probe user
  gained its own standing bootstrap (`deploy-probes.mjs:4678`; the sync
  recorded in `65deb41`).
- `docs/RELEASE-NOTES-v1.3.1.md` §8 "One new migration: 0044" — predates
  `0045_gigantic_retro_girl.sql` (`7b589c7`); fixed by §6 above.

# RD20 wrap-redeploy — preflight report + runbook

Status: preflight COMPLETE (2026-10-27). All checks ran read-only; the only file
this document's preflight wrote is this file. Scratch dirs under /tmp were removed
after the checks.

## 0. Preflight verdicts (summary)

| # | Prereq | Verdict | Evidence |
|---|--------|---------|----------|
| 1.1 | `scripts/build-gitea-assets.mjs` runs clean, never writes inside `gitea/` | **PASS** | exit 0; 784 files / 13.9 MB emitted to a scratch `--out`; `git -C gitea status --porcelain` byte-identical before/after (0 entries both) |
| 1.2 | `scripts/gen-ui-icons.mjs` regenerates cleanly; stays out of git status | **PASS** | wrote `icons.generated.ts` (45 icons, 18896 bytes); file is gitignored (`.gitignore:24`); `git status --porcelain` has no icons entry after regen |
| 1.3 | `.dev.vars` exists at `apps/worker` with 0600 | **FAIL (perms only)** | file exists, gitignored, correct keys — but mode is **664**, not 0600. Fix: `chmod 600 apps/worker/.dev.vars` before the window (step 3 copies it with 0600 regardless) |
| 1.4 | No new env var/binding in landed modules that `wrangler.jsonc` lacks | **PASS** | all `c.env.*` reads = DB, REPO, REGISTRY, REPO_PACKS, REPO_TASKS, MIRROR_SYNC_QUEUE — all declared; Env type in `worker-configuration.d.ts` matches config 1:1 |
| 2.1 | Remote migrations state matches expectation | **PASS** | remote pending = exactly `0033_sleepy_mandrill` + `0034_happy_nemesis` (applied through 0032) |
| 2.2 | Bindings present remotely, no `database_id` drift | **PASS** | D1 reachable at id `a72f93d3-f85a-411e-880e-7effaed306bb` (same as wrangler.jsonc); R2 bucket `cf-gitea-packs` exists |
| 3.1 | `/tmp/rd20-pat.txt` exists with 0600 | **PASS** | mode 0600, 46 bytes; content never read |
| 3.2 | PAT still authorizes | **PASS** | `GET /api/v1/user` with the token → **200** |
| 3.3 | D1 residue: secrets 0 rows; only p0probe's repo | **PASS** | `SELECT COUNT(*) FROM secrets` → 0; `repositories` → exactly 1 row: `p0probe/p0-shallow` |
| 4.1 | 0033 + 0034 are additive / live-DB safe | **PASS** | see §5 |

**Must fix before the window:** only item 1.3 — `chmod 600 apps/worker/.dev.vars`.
Everything else is green.

## 1. Local prerequisites — details

### 1.1 Assets prebuild (`node scripts/build-gitea-assets.mjs`)

Ran for real against the current `gitea/` pin (`fc4936884584`), with
`--out /tmp/rd20-preflight/assets` so the repo tree stayed untouched:

- `pnpm install --frozen-lockfile` + `vite build` succeeded; manifest verified;
  `img/avatar_default.png` present in the emitted tree.
- **Submodule hygiene is enforced twice by the script**: required-input checks
  read only; `--out`/`--work` inside `gitea/` hard-fail
  (`scripts/build-gitea-assets.mjs:136-138`); the build itself runs in an
  `mkdtemp` under `os.tmpdir()`. Verified empirically: `git -C gitea status
  --porcelain` was empty before and after.
- **Known wart:** the script does NOT delete its work dir on success — every run
  leaves `/tmp/gitea-assets-build-*` behind (several stale ones exist). The
  runbook's cleanup step removes the window's own dir; stale dirs are harmless
  scratch but can be swept manually.

### 1.2 Icon regeneration (`node scripts/gen-ui-icons.mjs`)

Deterministic emission (fixed allowlist order, no timestamps) from the same
`gitea/` pin; 45 icons, byte-identical output across runs. The generated file is
gitignored (`.gitignore:24`), and after regeneration `git status --porcelain`
showed no icons entry. It is wired as predev/prebuild/pretest, so the window
normally never runs it by hand — it is listed in the flow for completeness.

### 1.3 `.dev.vars`

- Exists at `apps/worker/.dev.vars`, gitignored.
- Keys present: `GIT_TOKEN`, `MIRROR_ALLOWED_HOST_LIST`, `MIRROR_CREDENTIAL_KEY`,
  `MIRROR_EGRESS_MODE` (key names only inspected — values never read).
- **Mode is 664, expected 0600** — the single preflight FAIL. The window's copy
  step applies 0600 to the worktree copy anyway; fix the source file too:
  `chmod 600 apps/worker/.dev.vars`.

### 1.4 Env/binding completeness

Grepped every `c.env.*` / `env.*` read under `apps/worker/src` (including the
just-landed content-history, notification-prefs, stars, admin-pages, settings
modules) and compared against `wrangler.jsonc` + `worker-configuration.d.ts`
(hash `66f64acbd3e951778775a65dbad0a8f3`, generated from the current config):

- Declared and used: `DB` (D1), `REPO`/`REGISTRY` (DO), `REPO_PACKS` (R2),
  `REPO_TASKS`/`MIRROR_SYNC_QUEUE`/`WEBHOOK_DELIVERY` (Queues), `ASSETS`,
  `APP_URL` (var), secrets `GIT_TOKEN`, `MIRROR_ALLOWED_HOST_LIST`,
  `MIRROR_CREDENTIAL_KEY` (all in `secrets.required`).
- Read but deliberately undeclared — all optional with code defaults, no action:
  - `WEBHOOK_EGRESS_MODE`, `WEBHOOK_ALLOWED_HOST_LIST` (`src/webhooks/ssrf.ts`,
    `src/webhooks/consumer.ts`): unset ⇒ "lax" SSRF posture.
  - `MIRROR_EGRESS_MODE` (`src/services/mirror/sync.ts`, `src/api/services/{mirror,push-mirrors}.ts`):
    unset ⇒ "lax". Note it sits in `.dev.vars` but is NOT in `secrets.required`,
    so wrangler silently drops it in local dev (documented in the wrangler.jsonc
    comment); production behavior is the code default. Informational only.
  - `TEST_MIGRATIONS`: test-only, injected by `vitest.config.ts`
    (`readD1Migrations`); never a deploy binding.

No recently landed module needs a binding `wrangler.jsonc` lacks.

## 2. Remote state (read-only wrangler)

- **Migrations**: `wrangler d1 migrations list cf-gitea --remote` → pending:
  `0033_sleepy_mandrill.sql`, `0034_happy_nemesis.sql`. Remote applied through
  0032. Matches expectation exactly.
- **Deployed version**: `b928537a-02e8-486a-8f4d-f3b2c25cb354`, created
  **2026-10-26T12:04:22Z**, serving 100%. The newest commit at that moment was
  `58c6cf0`; HEAD is **173+ commits ahead** (and still moving — wave landings
  were committing during this preflight). This wrap-redeploy is the catch-up;
  that is why the flow pins a GO commit and builds from a detached worktree.
- **Bindings live**: D1 queries succeeded against database id
  `a72f93d3-f85a-411e-880e-7effaed306bb` — identical to `wrangler.jsonc`
  `database_id`, **no drift**. R2 bucket `cf-gitea-packs` exists in the account.

## 3. PAT / probe prerequisites

- `/tmp/rd20-pat.txt`: exists, mode 0600, 46 bytes. Content never read or logged.
- Authorization probe: `curl -s -o /dev/null -w "%{http_code}" -H
  "Authorization: token $(cat /tmp/rd20-pat.txt)"
  https://cf-gitea.hecongw.workers.dev/api/v1/user` → **200**. The token only
  ever transits via the unexpanded `$(cat …)`; only the status code was reported.
- D1 residue (SELECT-only):
  - `secrets` → **0 rows** (expected 0).
  - `repositories` → **1 row**: `p0probe/p0-shallow` (expected: only p0probe's).

## 4. Migration safety review

### 0033_sleepy_mandrill.sql (issue_content_history)

```sql
CREATE TABLE `issue_content_history` (...8 columns...);
CREATE INDEX `issue_content_history_issue_idx`   ON `issue_content_history` (`issue_id`);
CREATE INDEX `issue_content_history_comment_idx` ON `issue_content_history` (`comment_id`);
CREATE INDEX `issue_content_history_edited_idx`  ON `issue_content_history` (`edited_unix`);
```

Purely additive: one brand-new empty table + three new indexes. No ALTER of
existing tables, no DROP, no data migration. Safe on a live DB with data.

### 0034_happy_nemesis.sql (notification prefs)

```sql
ALTER TABLE `user_settings` ADD `email_notifications_preference`        text DEFAULT 'enabled'      NOT NULL;
ALTER TABLE `user_settings` ADD `actions_email_notifications_preference` text DEFAULT 'failure-only' NOT NULL;
```

Purely additive: two new columns on `user_settings` (created in
`0008_awesome_lilith.sql`, so it exists at the 0032 state). Both have constant,
non-NULL defaults, which SQLite permits on a populated table — existing rows get
the defaults, no table rebuild, no lock hazard beyond the brief schema write.
**Nothing destructive in either file.** Both run exactly once via D1's
migrations tracking table; re-running the apply step is a no-op.

## 5. Runbook — RD20 wrap-redeploy (the window itself)

GO_COMMIT = `<GO-COMMIT-SHA>` — fill with the commit the orchestrator pins at
window open. Every step below runs inside the detached worktree unless stated.

```bash
# 0) Precondition (one-time, before the window): fix the preflight FAIL
chmod 600 /home/whc/pnpm_repos/cf-gitea/apps/worker/.dev.vars

# 1) Detached worktree at the GO commit (isolates the build from in-flight waves)
git -C /home/whc/pnpm_repos/cf-gitea worktree add --detach /tmp/rd20-wrap "$GO_COMMIT"
cd /tmp/rd20-wrap

# 2) Install (lockfile is committed; must not resolve anything new)
pnpm install --frozen-lockfile
#    GATE: exits 0; no "already up to date" lockfile surprise (pnpm release-age
#    gate) — if it fails, STOP, the GO commit's lockfile needs the age window.

# 3) Assets prebuild — never writes inside gitea/ (verified in preflight)
node scripts/build-gitea-assets.mjs
#    GATE: "build-gitea-assets: SUCCESS", ~13.9 MB emitted into
#    apps/worker/public/assets; `git -C gitea status --porcelain` still empty.
#    NOTE: leaves /tmp/gitea-assets-build-<rand> behind — rm -rf it in step 11.

# 4) Icons (normally a pretest hook; run explicitly to fail here, not mid-suite)
node ../../scripts/gen-ui-icons.mjs
#    GATE: "gen-ui-icons: wrote ... (45 icons ...)"; `git status --porcelain`
#    must NOT list icons.generated.ts (gitignored).

# 5) Dev vars for the worktree (0600 — the worktree copy is fresh, not inherited)
install -m 600 /home/whc/pnpm_repos/cf-gitea/apps/worker/.dev.vars \
               /tmp/rd20-wrap/apps/worker/.dev.vars
#    GATE: stat -c '%a' → 600.

# 6) Typecheck (regenerates dist-types via workspace order; wrangler types runs first)
pnpm -r typecheck
#    GATE: tsc clean across engine + worker. This is its own gate — vitest does
#    not typecheck across files.

# 7) Full suite
pnpm -r test
#    GATE: honest vitest summary with 0 failures, read with your own eyes; never
#    pattern-match or pipe through grep inside a && chain (AGENTS.md rule).

# 8) Deploy + remote migrations (the only mutating remote steps)
cd apps/worker
npx wrangler deploy
pnpm db:migrate:remote
#    GATE: deploy prints the new Version ID (record it for the evidence paste);
#    migrate applies exactly 0033_sleepy_mandrill + 0034_happy_nemesis, then a
#    re-run of `list --remote` shows nothing pending.

# 9) Probe battery (8 batteries; PAT file, never inline the token)
node /tmp/rd20-wrap/scripts/deploy-probes.mjs <battery> \
  --base-url https://cf-gitea.hecongw.workers.dev --token-file /tmp/rd20-pat.txt
#    (repeat per battery; --dry-run first if unsure of battery names)
#    GATE: all batteries green.

# 10) Force-redeploy rehearsals (per the RD18/RD19 standard), then evidence paste
#     — record: version IDs, probe outputs, migration output, HEAD sha.

# 11) Cleanup (leave the shared repo tree untouched)
cd /home/whc/pnpm_repos/cf-gitea
git worktree remove --force /tmp/rd20-wrap
rm -rf /tmp/gitea-assets-build-*        # this window's dir; sweep stale ones too
#    PAT file: keep at /tmp/rd20-pat.txt (0600) unless the orchestrator says otherwise.
```

Expected end state, verifiable with read-only commands:

- `wrangler deployments list` → a fresh version at 100% created moments ago.
- `wrangler d1 migrations list cf-gitea --remote` → nothing pending.
- `GET /api/v1/user` with the PAT → 200.
- D1: `secrets` still 0 rows; `repositories` still only `p0probe/p0-shallow`
  (plus anything the probe battery intentionally creates — re-check residue
  after probes if the battery creates fixtures).
- `git -C gitea status --porcelain` → empty; worktree gone; no scratch dirs left.

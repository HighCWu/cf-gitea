# Fresh-clone proof — 2026-10-28

Read-only verification unit (fresh-clone proof wave): simulated the exact flow
a third party (or the Deploy button's clone) hits from ZERO, entirely in a
scratch clone under `/tmp` (deleted after the proof; the single repo
deliverable is this document). Proves the example-file graduation
(`wrangler.jsonc` untracked, `.example` committed, CI `cp` steps) works for
someone who is not us.

**Verdict: FRESH-CLONE-OK** — every flow step a third party hits works from a
zero state at HEAD `57794e7`. Two attached findings, neither flow-blocking:

1. **DEVIATION (papercut, has an in-repo documented fix):** bare
   `pnpm typecheck` on a fresh clone FAILS until `pnpm gen:icons` runs once.
   The README quickstart path (`pnpm dev`) is unaffected — the root `predev`
   hook generates icons automatically — and CI already orders `gen:icons`
   before `typecheck` in all three jobs. A typecheck-first third party hits
   it. Suggested hardening: a root `pretypecheck` hook or a README note.
2. **PUBLISH-DECISION (not a flow issue):** pre-graduation git history still
   carries the real `wrangler.jsonc` (untracked at `f72c697`, 2026-10-28
   11:12) — with the real D1 `database_id`
   `a72f93d3-f85a-411e-880e-7effaed306bb` and real
   `APP_URL https://cf-gitea.hecongw.workers.dev` — in every commit from the
   initial scaffold (`ab61b5a`) through `f72c697~1`. `.dev.vars` was NEVER
   committed and no secret VALUE ever shipped (secrets appear only as
   declared names). A fresh clone at HEAD has a clean working tree and clean
   HEAD tree; the identifiers ride in history. Doctrine-consistent acceptance
   is defensible (AGENTS.md: a database_id is "not secret — account auth is
   required to use it"), but public publish ships this history to everyone —
   accept explicitly or scrub before going public.

---

## Method and transcript (condensed, honest)

Provenance: `git clone --recurse-submodules
file:///home/whc/pnpm_repos/cf-gitea /tmp/cf-gitea-fresh` — clone pinned at
`57794e7` (the source repo advanced to `bd59bc4b` mid-clone from concurrent
landings; the clone is a valid snapshot. The source's only uncommitted drift
on proof-relevant files was `wrangler.jsonc.example` comment text — the APP_URL
optionality doc riding a sibling feature wave; zero functional config
difference).

### Step 1 — clone + submodule

```
正克隆到 '/tmp/cf-gitea-fresh'...
子模组 'gitea'（https://github.com/go-gitea/gitea）已对路径 'gitea' 注册
正克隆到 '/tmp/cf-gitea-fresh/gitea'...
error: RPC 失败。curl 92 HTTP/2 stream 5 was not closed cleanly: CANCEL (err 8)
fetch-pack: unexpected disconnect while reading sideband packet
fatal: 过早的文件结束符（EOF）
克隆 'gitea' 失败。按计划重试        ← git's built-in retry
正克隆到 '/tmp/cf-gitea-fresh/gitea'...
子模组路径 'gitea'：检出 'fc4936884584a41931906553d96c2601d750e6ef'
CLONE_EXIT=0
```

Result: **PASS.** The submodule DOES init from the clone — it fetches from the
recorded URL `https://github.com/go-gitea/gitea` (reachable; ~245 MB), checks
out exactly the pin `fc493688` and lands clean. Honest caveat: the first
GitHub fetch attempt died mid-stream (curl 92 / HTTP/2 CANCEL) and git's
automatic per-submodule retry recovered on attempt 2 — on a flaky network a
third party may need `git submodule update --init --recursive` a second time.
Not publish-blocking; worth knowing.

### Step 2 — example files

`cp apps/worker/wrangler.jsonc.example apps/worker/wrangler.jsonc` and
`cp apps/worker/.dev.vars.example apps/worker/.dev.vars` — both example files
exist and are complete (committed `wrangler.jsonc.example` is
self-documenting: placeholder `database_id`, `APP_URL` placeholder, secrets by
name only; `.dev.vars.example` carries `GIT_TOKEN=devtoken`). Result: **PASS**
— and immediately after the copies, `git status` is still empty (both targets
correctly gitignored: `.gitignore:31` and `.gitignore:18`).

### Step 3 — `pnpm install` (lockfile + workspace from scratch)

```
Scope: all 3 workspace projects
✓ Lockfile passes supply-chain policies (verified 2d ago)
Lockfile is up to date, resolution step is skipped
Packages: +198 ... reused 198, downloaded 0, added 198, done
Done in 334ms using pnpm v12.13.0    PNPM_INSTALL_EXIT=0
```

Result: **PASS.** The committed lockfile resolves cleanly — no release-age-gate
failure, no resolution error. Caveat for honesty: this machine had a warm
content-addressable store (198 reused / 0 downloaded — a cold machine would
download those 198 packages over the network), but the parts a fresh clone
exercises — full resolution validation, the pnpm 12 supply-chain policy check
against the lockfile, workspace wiring — all ran and passed.

### Step 4 — `pnpm typecheck` (wrangler types against the example-restored config)

First run: **FAIL — but not the graduation's fault.** `wrangler types`
succeeded against the copied example config (`✨ Types written to
worker-configuration.d.ts`), proving the config restore works; `tsc` then
failed on the gitignored generated icon module:

```
src/ui/icons.ts(13,28): error TS2307: Cannot find module './icons.generated'
src/ui/icons.ts(14,31): error TS2307: Cannot find module './icons.generated'
src/ui/shell.tsx(38,36): error TS7006: Parameter 'd' implicitly has an 'any' type.  ← cascade
[ELIFECYCLE] Command failed with exit code 2.
```

`apps/worker/src/ui/icons.generated.ts` is gitignored (`.gitignore:24`) and
generated by `pnpm gen:icons` — a step CI runs explicitly before typecheck in
all three jobs, and the root `predev` hook runs it automatically on
`pnpm dev` (so the README quickstart self-heals). Only a bare typecheck-first
path hits the gap. After `pnpm gen:icons` (which worked from the clone's OWN
submodule inputs: "45 icons, 18896 bytes, gitea pin inputs from
/tmp/cf-gitea-fresh/gitea/public/assets/img/svg"):

```
✨ Types written to worker-configuration.d.ts   TYPECHECK_EXIT=0
```

Result: **PASS after the documented step** — full `tsc --noEmit` clean, with
`wrangler types` regenerated from the example-restored config both times.
**This is the one deviation a third party would hit** (finding 1 above).

### Step 5 — vitest smoke (workerd boots from the clone)

```
$ npx vitest run src/api/identity.test.ts
Using secrets defined in .dev.vars
▲ [WARNING] Missing required secrets: MIRROR_ALLOWED_HOST_LIST, MIRROR_CREDENTIAL_KEY.
 ✓ src/api/identity.test.ts (25 tests) 1070ms
 Test Files  1 passed (1)   Tests  25 passed (25)   Duration  7.58s
VITEST_EXIT=0
```

Result: **PASS — 25/25**, the workerd test runtime boots in the clone, reads
the copied `.dev.vars`, D1/DO/R2 bindings come up from the example config.
The MIRROR warning is benign and matches the README's contract ("plain local
dev needs only GIT_TOKEN; the two MIRROR_* keys are read by the pull-mirror
features, which preflight them and print the exact missing piece") — a third
party sees a warning, not a failure.

### Step 6 — clone stays clean through the whole flow

After ALL steps (installs, typecheck, gen:icons, vitest):

- `git status --porcelain` → **0 entries.** Every generated artifact the flow
  produces is properly gitignored: `worker-configuration.d.ts`
  (`**/worker-configuration.d.ts`), `icons.generated.ts` (line 24),
  `node_modules/`, and (had we built) `dist/`, `.wrangler/`.
- `git -C gitea status --porcelain` → empty; the submodule stays pristine.

Result: **PASS** — the flow never dirties a tracked file.

### Step 7 — graduation promise: no account-local files in the clone

Working tree at clone time (before the intentional `cp`s): no
`wrangler.jsonc`, no `.dev.vars`, no `.wrangler/` state, nothing account-local
— verified. HEAD tree: `git ls-tree HEAD` carries only the `.example` files.
History scan across ALL commits:

- `.dev.vars` — **never committed, ever.**
- Secret values — never committed; secrets exist only as the declared-names
  list in the config template.
- The real `wrangler.jsonc` — committed from `ab61b5a` (initial scaffold)
  until untracked by `f72c697` ("chore(release): untrack the real
  wrangler.jsonc — the graduation's deletion half", 2026-10-28 11:12), carrying
  the real D1 `database_id` and real `APP_URL` (finding 2 above). A fresh
  clone's checkout at HEAD contains none of it; the bytes ride in history.

Result: **PASS for the clone; one publish-policy decision attached.**

## Deviation ledger (what a third party would actually hit)

| # | What | Severity | Third-party experience | Fix path |
|---|------|----------|------------------------|----------|
| 1 | Bare `pnpm typecheck` before any `gen:icons` fails (TS2307 icons.generated) | Papercut | Two confusing TS errors on a typecheck-first flow; `pnpm dev` (the README path) unaffected — `predev` generates icons | Root `pretypecheck` hook or README note (recommend the hook — CI already encodes the right order) |
| 2 | Pre-graduation history carries real `database_id` + real workers.dev `APP_URL` | Publish decision | Invisible to the flow; ships with every public clone | Accept explicitly per the not-secret doctrine, or history-scrub before public publish |
| 3 | First gitea submodule fetch can die mid-stream on a flaky network (observed: curl 92, recovered by git's automatic retry) | Environmental | Re-run `git submodule update --init --recursive` if the clone errors | None needed; optionally note in README |

## Proof environment notes

- Clone source: local `file://` path (submodule still fetched from its
  recorded GitHub URL — the third-party path for the submodule).
- Clone HEAD `57794e7`; submodule pin `fc493688`; scratch `/tmp/cf-gitea-fresh`
  deleted after the proof.
- pnpm 12.13.0; nothing installed, built, or modified inside `gitea/`; no repo
  file touched except this document.

## Orchestrator decision record (2026-10-28, appended at landing)

**Surprise 2 — ACCEPTED for publish.** The arbitration verified the fresh-clone
unit correct and the secret scan's "identical placeholder" claim wrong: the real
`database_id` has been committed since the initial scaffold (`ab61b5a`), under a
comment claiming it was a placeholder. Acceptance rationale: (1) AGENTS.md's own
doctrine — a D1 database_id is inert without account-scoped credentials; (2) a
history scrub means rewriting all 718 commits, invalidating every commit-hash
citation across the SPECs/ADRs/evidence/notes — this repository's documentation
IS its provenance; (3) the workers.dev URL is intentionally public. The scan
verdict remains PUBLIC-SAFE; its one misclassification is corrected here.

**Surprise 1 — remediated in the same change**: the root `pretypecheck` hook
(`pnpm gen:icons`) makes `pnpm typecheck` work on a fresh clone first-try,
matching the existing `predev`/`pretest` hooks (verified end-to-end, exit 0).

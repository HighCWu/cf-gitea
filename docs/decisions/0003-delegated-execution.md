# ADR-0003: Delegated execution model (how cf-gitea gets built)

Status: accepted · Date: 2026-10-24 · Operates under the session goal
("自主编排…恒保6个后台并行；文件所有权互斥，门禁常绿，决策留档；不可逆动作外无需请示").

## Context

cf-gitea is built by a single orchestrator session driving a standing pool of
background subagents. After ~20 dispatches (SPEC authoring, engine milestones,
API batches, infra tooling) the pattern has stabilized and is worth recording:
future sessions and maintainers should reproduce it, not rediscover it.

## The model

1. **Standing pool**: keep up to 6 background subagents running at all times.
   Every completion notification triggers the same loop: review the output →
   run the affected gates → commit the landed unit atomically → immediately
   dispatch the next goal from the queue (dependency-ready + ownership-free).
2. **Exclusive file ownership per dispatch**: every prompt names the files the
   agent may create/modify; shared files (`src/index.ts`, root `package.json`,
   `wrangler.jsonc`, `.gitignore`) are orchestrator-only, and when an agent
   must touch one it is granted explicitly and only after the previous owner
   landed. Parallel dispatches are sequenced AROUND shared files, never
   through them (the api-router mount waited three waves for `index.ts`).
3. **Spec-first, corrections queue**: implementation agents consume SPECs as
   contracts; when a landing surfaces SPEC errors, cross-SPEC corrections are
   queued and folded by the orchestrator the moment the affected SPEC is
   unowned (never edited mid-implementation — moving-target rule).
4. **Gates and commit policy**: typecheck/lint/test/check:api/check:contract
   per AGENTS.md; agents leave gates green in their scope; the orchestrator
   commits when the owning agent lands (atomic units; agents never commit).
   Transient root-gate redness from in-flight parallel units is expected and
   scoped, never "fixed" by crossing ownership.
5. **Orchestrator work**: integration of shared files, review/ratification of
   agent designs, ADRs and SPEC edits, cloud provisioning/deployments,
   urgent cross-cutting fixes (e.g. the ci.yml YAML parse bug), and direct
   implementation only in genuinely unowned zones.
6. **Irreversible/outward actions**: production deploys and resource creation
   are orchestrator-only under the standing autonomy grant; anything
   destructive still goes to the human.

## Evidence it works

- ~22 atomic commits; production live and smoke-verified; e2e allowlist held
  byte-stable across four waves of engine surgery.
- Ownership discipline caught real conflicts before they happened (api mount,
  schema.ts, `index.ts` handoffs); the one YAML parse bug and one stale-dist
  deploy failure were orchestrator-owned and fixed in-loop.
- Two documented stumbles (commits landed with failing tests during the U1
  manifest work) — the verification loop caught both within one step; lesson:
  never trust pattern-matched gate output, read the failures.

## When NOT to use this model

Single-file surgical work, anything needing tight interactive iteration with
the human, or when no dependency-ready unowned goal exists — dispatching
make-work is worse than running with fewer agents.

## Amendment — operational history (2026-10-24/25)

Appended 2026-10-25, after 158 further commits (f1942d0..HEAD: tier-1
completion, the tier-2 sweep, UI, sessions, mirrors, two production
deploys). The decision above stands unchanged; this records how it behaved
under load, so the next session reproduces the practice, not just the
intent.

### 1. The landing loop, as actually run

Agents run async (`run_in_background`); every completion runs the same
four-step loop:

1. **Verify** — the orchestrator reads the `Tests ` line for the affected
   scope with its own eyes (AGENTS.md pre-commit checklist, 3e7ff8c).
2. **Commit** — by explicit pathspec staging of the brief's owned files.
   **Flagged divergence:** AGENTS.md still reads "agents never run git
   commit"; during this window the landing commit was granted per-brief to
   agents (e.g. the resumed waves landed as their own atomic pathspec
   commits, 4bb3c26 and 89f6f1b), with shared files, arbitration and the
   REG step reserved to the orchestrator. The override is per-brief, never
   ambient — and it post-dates this ADR's item 4.
3. **REG sweep** — router registration is orchestrator-only and follows
   every API landing: eight sweeps walked declared 178→261 in one day
   (d8236ef 178→182, b5caa17 182→197, 92ea66f 197→204, a618b7c 204→212,
   e281e53 212→217, 0473d58 217→234, 8928f04 234→253, 497c973 253→260;
   a4979f7 the 261st), each verified by `pnpm check:api`
   (`scripts/check-openapi.mjs` — the `declared:` line it prints is the
   number in the commit subject). Implementation and registration stay
   decoupled: an agent lands routes; the orchestrator registers the moment
   `index.ts` ownership is free.
4. **Re-dispatch immediately** — the completion-loop discipline
   (fdafcf3; pool target 6; temporary throttle windows honored, 914c70d).

### 2. Merge arbitration precedents

Ownership violations were arbitrated case-by-case, not reflexively reverted:

- **Ratified**: the mirror-e2e wave added a `test:mirror` line to root
  `package.json` (an orchestrator-only file). The line mirrored `test:lfs`
  exactly, so the orchestrator ratified it in place (1bced5f) instead of
  reverting, then gave the suite a CI job (c114209).
- **Countermanded**: the redeploy wave's smoke PAT was echoed into agent
  logs — misdirected. Countermand, not ratify: the orchestrator deleted the
  token from `personal_access_tokens` and reaffirmed mint-per-run for probe
  credentials (docs/design/p0-evidence.md "Operational note", 91a87f9).
- **Granted**: the orphan-cleanup wave (engine-admin DELETE left D1 orphan
  rows, live-demonstrated by the deploy smoke's cleanup) needed `gate.ts` —
  owned by the in-flight §2.1-widening wave. The design stayed the owner's
  (SPEC-0003 §2.5.5 pipeline order); the small intercept hunk in
  `handleEnginePathBranch` was applied by the orchestrator into the wave's
  coherent unit and committed together — the "co-authored landing"
  (3bc942e).

### 3. Failure modes that became rules

Three strikes in the first evening, three rules (AGENTS.md pre-commit
checklist, 3e7ff8c):

- **Tests red at commit** — a summary pattern-matched green while the tests
  were red → see the `Tests ` line yourself; never trust the claim.
- **Directory-scoped `git add`** — silently missed sibling paths (two
  escaped commits) → `git status` the whole tree; stage by explicit
  pathspec.
- **Concurrent-window edit lost** — a rejected edit plus a neighbor's
  successful commit is indistinguishable from success → re-verify your own
  change landed before committing.

Two more rules arrived with the tier-2 sweep (ADR-0005): **vitest does not
typecheck** — green vitest runs hid tsc errors that the next wave's
typecheck caught (793f88d; ADR-0005 D2: `pnpm typecheck` is a separate
mandatory gate); **ambient config leaks into tests** — binding `APP_URL`
flipped hardcoded origin expectations (fb1c1c5), and ambient `.dev.vars`
broke a no-KEK test (bde4cb1) — two instances, one rule: tests read the
configured value or take explicit overrides (ADR-0005 D3).

### 4. Freeze discipline

The deploy green window had a Zeno problem: while a deploy is pending, every
new landing re-dirties the tree the deploy agent must gate, so the window
never closes. The 2026-10-25 redeploy fixed it with a **full dispatch
freeze** — no new dispatches until the deploy agent shipped. The wait was
~75 minutes and ended in version `15802991` (09:28 CST, redeploy of
bde4cb1; gates and smoke recorded in docs/design/p0-evidence.md
§"Redeploy verification": tsc 0 errors, vitest 1854/1854, check:api PASS,
smoke 5/5). Lift → immediate refill: the 09:41–10:00 burst
(72626e5 … 0a9f551). Deploys were already orchestrator-only (The model,
item 6); the amendment is that everything else holds still while one runs.

### 5. Quota-kill resume

The 2026-10-25 05:30 provider quota kill took waves mid-flight (last
commits 2278fc6 and 2788d3c at 05:30; nothing until 07:45). Half-done work
survived in the tree; the resume protocol: **inventory the tree first,
preserve sound half-work, brief resume-agents read-and-preserve-first**.
Both resumed agent waves landed (issue-tables 4bb3c26 with migration 0012;
repo-extras 89f6f1b, 19 ops); the guard wave (SPEC-0003 §2.1 ACL widening)
was completed by the orchestrator instead — two fixture bugs fixed
(duplicate token name, `redirect:manual`), no product change (70c9c3d).

### 6. Consequences

- **Throughput** (2026-10-25, one day): declared API surface +83 ops
  (178→261, the eight REG sweeps); migrations 13→14 (0011 2c69209, 0012
  4bb3c26, 0013 89698b4 applied to remote D1 at the redeploy; 0014 in
  flight); three UI waves (7e1d22b, 6fe81f2, sessions 89698b4 + baddcde);
  the mirror black-box e2e suite (a38f92e) with CI (c114209); two
  production deploys (cf93d51f ~04:15 CST, 15802991 09:28 CST — both
  recorded in docs/design/p0-evidence.md).
- **Cost**: context per wave — every brief carries the ownership list, the
  gate list and the corrections queue; and the orchestrator remains the
  serialization point (REG sweeps, shared files, arbitration all queue
  behind one session).
- **When NOT to parallelize** — same-file seams run as single-owner chains
  under the pool, not through arbitration: `apps/worker/src/db/schema.ts`
  went 0011→0014 one owner at a time (2c69209 → 4bb3c26 → 89698b4 → the
  in-flight wave; SPEC-0010 was ratified early precisely to free schema
  ownership, ae89563), and `src/ui/` likewise wave2→wave4 (7e1d22b →
  6fe81f2 → the in-flight pages wave). A dependent chain ran sequentially;
  the parallelism went to independent seams around it.

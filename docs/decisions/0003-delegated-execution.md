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

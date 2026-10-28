# Contributing to cf-gitea

Questions, bug reports, and feature proposals start as a
[GitHub Issue](https://github.com/HighCWu/cf-gitea/issues) (please use an issue
template so we can act fast). All code, comments, docs, and commit messages are
written in **English**.

## Prerequisites

- **Node >= 24** (the plain-Node tooling — e.g. the API contract check — reaches the engine router, which uses the web-platform `URLPattern`; Node 24 is the first LTS shipping it), **git >= 2.22**, and **pnpm** — the only package manager; use the
  version from the `packageManager` field in `package.json` (`corepack enable`).
- Wrangler ships as a devDependency of `apps/worker`; you only need a Wrangler login
  (`pnpm --filter cf-gitea-worker exec wrangler login`) for the deploy path.

## Getting started

```bash
git clone https://github.com/HighCWu/cf-gitea && cd cf-gitea
git submodule update --init --recursive   # fetches the gitea/ reference sources
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # local dev token (GIT_TOKEN=devtoken)
pnpm db:migrate:local                     # apply Drizzle migrations to local D1
pnpm dev                                  # http://127.0.0.1:5173 — workerd, real local D1/DO/R2
```

On a flaky network the `gitea/` submodule fetch can fail transiently mid-stream;
git's per-submodule retry usually recovers — if the clone errors, just re-run
`git submodule update --init --recursive`.

The `pre*` hooks auto-generate the UI icons before `pnpm dev` / `pnpm build` /
`pnpm typecheck` / `pnpm test`, and `pnpm typecheck` also regenerates the worker
binding types — those files are generated artifacts and are never committed, so
your first session is exactly the commands above, no extra setup.

Create an admin and use it like any git host (the first push creates the repo):

```bash
node scripts/bootstrap-admin.mjs <username> [email]   # mints an all-scopes PAT; plaintext prints once
git push http://<username>:<PAT>@127.0.0.1:5173/<username>/<repo>.git main
```

Full walkthroughs (deploy, mirrors, LFS, e2e recipes, troubleshooting): the
[README](README.md) and the [operator runbook](docs/ops/runbook.md).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run the Worker locally in workerd (bindings from `apps/worker/wrangler.jsonc`) |
| `pnpm build` | Build — required before `pnpm deploy` (deploy ships `dist/`) |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm lint` | ESLint (flat config at the repo root) |
| `pnpm test` | Fast loop — single vitest pass in workerd. **One file/scope only** |
| `pnpm test:full` | **The verdict that the suite is green** — the full-suite composite gate ([ADR-0006](docs/decisions/0006-full-suite-composite-gate.md)) |
| `pnpm test:lfs` / `pnpm test:mirror` | Black-box e2e suites (real `git-lfs` / mirror flows) |
| `pnpm db:generate` | Generate a Drizzle migration from the schema |
| `pnpm db:migrate:local` / `pnpm db:migrate:remote` | Apply migrations to local / production D1 |
| `pnpm check:api` / `pnpm check:contract` | `/api/v1` inventory vs the frozen Gitea contract |

Honesty rule: a plain `pnpm test` pass proves nothing about suite health at this
scale — never cite it as "full suite green". Quote the actual `Tests` summary line
from `pnpm test:full` (or name the exact scope a `pnpm test` run covered).

## How we work

- **SPEC first.** Non-trivial features and design-level fixes start with a SPEC in
  `specs/` (problem/scope, API surface, data model, edge cases, testing plan), kept
  in sync with the implementation. See the [SPEC index](specs/README.md); gated
  SPECs (e.g. [SPEC-0012 §1.1](specs/0012-actions-feasibility.md)) demand concrete,
  demonstrated demand before anything is built — propose via an issue first.
- **One PR, one logical change.** Keep the diff scoped to what the description
  claims; if something extra must fold in, do it deliberately and say so explicitly.
- **Schema changes ship a generated migration** (`pnpm db:generate`). D1 access goes
  through Drizzle ORM; blob access through the storage service layer; routes stay thin.
- **The `gitea/` submodule is a read-only reference** — never commit changes to it.
  Keep generated artifacts (`dist/`, `dist-types/`, `.wrangler/`,
  `worker-configuration.d.ts`) out of commits. `pnpm-lock.yaml` IS committed;
  dependencies stay at latest stable (no alpha/beta/RC dist-tags).
- **`apps/worker/wrangler.jsonc` is gitignored** (it carries your account's real
  resource ids); the committed template is `apps/worker/wrangler.jsonc.example`.
- Full conventions (verification layers, architecture boundaries, Workers rules)
  live in [AGENTS.md](AGENTS.md) — written for AI coding agents, but it is the same
  house rules humans are held to.

## Submitting a PR

## Submitting a PR

The [PR template](.github/PULL_REQUEST_TEMPLATE.md) walks the landing checklist:
scoped suites green with the `Tests` line quoted, `pnpm typecheck` + `pnpm lint`
clean, SPEC written/updated in the same change, submodule and generated files
untouched. CI runs typecheck/lint, the composite gate, both contract checks, the
real-git e2e allowlist, LFS + mirror e2e, benchmarks, and asset determinism.

# cf-gitea

A Gitea-compatible, headless git forge backend running entirely on Cloudflare Workers.
Stock git clients (`clone`/`push`), Gitea API tooling (SDKs, `tea`, release automation,
terraform providers) work against it unmodified; the official Gitea web UI is the
long-term frontend (asset-reuse strategy, SPEC-0008+).

## Architecture at a glance

```
git client ──▶ Worker (Hono, edge)
                 ├─ git smart-HTTP ──▶ RepoDO (refs, leases, catalog) + R2 (packs)
                 ├─ /api/v1 ─────────▶ D1 (users, repos, issues) + engine object reads
                 └─ auth ────────────▶ D1 (tokens: sha256 digests, scoped)
```

Self-hosted git engine (vendored [durable-git], evolving per the split-plane design):
R2 is the blob source of truth, one Durable Object per repository serializes writes,
D1 (Drizzle ORM) holds all product metadata. No containers, no managed git service.
Deep-dive: [ADR-0001](docs/decisions/0001-technical-direction.md) ·
[reference-project survey](docs/research/tech-route-survey.md).

## Status

Status snapshot **2026-10-24 23:15 CST** (parallel agent waves were landing while
observed; in-flight items are marked, not counted as done).

**Live** (first deploy 2026-10-24): <https://cf-gitea.hecongw.workers.dev> — real git
hosting works end to end against it (PAT-authenticated push, clone, token API). Landed:
the vendored engine through SPEC-0001a Steps 1-4 (Worker-side receive/scan/delta/idx,
lease RPCs, `storage_key` R2 addressing, pack_catalog, lifecycle RPCs, fail-closed
protocol parser; m2 benchmark baseline enforced: clone 14.2 MiB/s local), SPEC-0002
auth (PATs, scopes, token API), SPEC-0003 M1-M3 (git-HTTP ACL gate, lifecycle,
redirects, push-create, delete queue), the SPEC-0005 issue/PR data layer + webhook
delivery Queue consumer, the issues block of tier-1 API batch 5, SPEC-0006
LFS routes + services + a 33-check real-`git-lfs` e2e (`pnpm test:lfs`), SPEC-0007 org
services + tier-1 org routes, SPEC-0008 UI U1-U2.5 (asset pipeline, shell, router
module mounted), and a differential git-CLI harness (`pnpm diff:test`). Tier-1 API
coverage mounted at HEAD: **30 of 78 paths, 52 of 129 operations** (`pnpm check:api`);
batch 6 (the PR D1 block) is landed but its router registration rides the in-flight
import wave, so it is not counted yet. In flight: the >1 GiB import channel
(SPEC-0003 M5, server + client) and SPEC-0008 U3 (first three UI pages).
Eleven SPECs + three ADRs; CI runs typecheck/lint/tests, contract checks, the
real-git e2e suite (34 passed / 35-row headless-UI allowlist), benchmarks, and asset
determinism. See the [SPEC index](specs/),
[ADR-0002](docs/decisions/0002-contract-freeze.md) (contract freeze) and the
[runbook](docs/ops/runbook.md) (dev/deploy/bootstrap, differential/LFS e2e, import
clients).

## Development

```bash
git submodule update --init --recursive   # after clone (gitea/ is read-only reference)
pnpm install
pnpm dev          # vite dev — Worker runs in workerd with real local D1/DO/R2
pnpm typecheck && pnpm lint && pnpm test
pnpm db:migrate:local                    # apply Drizzle migrations to local D1
```

Full conventions (structure rules, dependency policy, parallel-agent workflow) live in
[AGENTS.md](AGENTS.md). New features start with a SPEC in `specs/`.

[durable-git]: https://github.com/littledivy/durable-git

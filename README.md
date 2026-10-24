# cf-gitea

A Gitea-compatible, headless git forge backend running entirely on Cloudflare Workers.
Stock git clients (`clone`/`push`), Gitea API tooling (SDKs, `tea`, release automation,
terraform providers) work against it unmodified; the official Gitea web UI is the
long-term frontend (asset-reuse strategy, SPEC-0006+).

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

**Live** (first deploy 2026-10-24): <https://cf-gitea.hecongw.workers.dev> — real git
hosting works end to end against it (PAT-authenticated push, clone, token API). Landed:
vendored engine with the M2 receive-in-Worker split (lease RPCs, R2 staging), SPEC-0002
auth (PATs, scopes, token API), the git-HTTP ACL gate (SPEC-0003 M1), issue/PR webhook
data layer, tier-1 API batches in flight (~9 of 78 paths), Tier-2 UI underway (asset
pipeline proven, shell landing). Nine SPECs + three ADRs; CI runs typecheck/lint/tests,
contract checks, the real-git e2e suite, benchmarks, and asset determinism. See the
[SPEC index](specs/), [ADR-0002](docs/decisions/0002-contract-freeze.md) (contract
freeze) and the [runbook](docs/ops/runbook.md) (dev/deploy/bootstrap).

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

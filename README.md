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

Early construction. Engine vendored and wired for local dev; SPECs 0001–0005 written;
auth, `/api/v1` skeleton, and CI landing now. See the [SPEC index](specs/) and
[ADR-0002](docs/decisions/0002-contract-freeze.md) for the compatibility-contract
freeze (the vendored `gitea/` submodule's swagger at its pinned commit is the
authoritative API contract).

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

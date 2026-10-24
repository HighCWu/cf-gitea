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

Status snapshot **2026-10-25 02:20 CST** (parallel agent waves were landing while
observed; in-flight items are marked, not counted as done).

**Live** (first deploy 2026-10-24): <https://cf-gitea.hecongw.workers.dev> — real git
hosting works end to end against it (PAT-authenticated push, clone, token API). Landed:
the vendored engine through SPEC-0001a in full (Worker-side receive/scan/delta/idx,
lease RPCs, `storage_key` R2 addressing, pack_catalog, lifecycle RPCs, fail-closed
protocol parser; m2 benchmark baseline enforced: clone 14.2 MiB/s local) plus
SPEC-0001b **in full** — merge base/graph/diff3/tree-merge/rebase/patch-id,
mergeability + executeMerge RPCs (3b30ba3) and the fork machinery (catalog
replication, 0223cb9; the PR `mergeable` field is live) — SPEC-0002 auth (PATs,
scopes, token API), SPEC-0003 M1-M5 (git-HTTP ACL gate, lifecycle, redirects,
push-create, delete queue, and the >100 MB chunked import channel with its
`scripts/import-client.mjs` / `import-batched-push.sh` clients, 09132c1), the
SPEC-0005 issue/PR/release data layer + webhook delivery Queue consumer, SPEC-0006
LFS routes + services + a 33-check real-`git-lfs` e2e (`pnpm test:lfs`, CI job),
SPEC-0007 org services + tier-1 org routes, SPEC-0008 UI U1-U3+U5 (asset pipeline,
shell, router module, the three repo pages, goldens/a11y/determinism), the
SPEC-0009 client half (`scripts/mirror-import.mjs` import-from-URL producer,
ab56ec9), the repository invariant checker (ref-closure + catalog↔R2 cross-check,
c91135d + 53276b7), and the differential git-CLI harness (`pnpm diff:test`).
Tier-1 API coverage mounted at HEAD: **49 of 78 paths, 85 of 129 operations**
(`pnpm check:api`, observed 02:20 CST). REG-MERGE-2 — the batch-8 /
release-assets / starred / user-settings router registration — sat in the
working tree at 02:17 CST reading **73/78 paths, 123/129 ops, PASS**, then was
withdrawn before committing: it is still pending at snapshot. The batch-8
route modules themselves are committed; only the registration rides. The 6
remaining operations (archive download, diffpatch, forks, languages, PR-merge
DELETE) belong to the wave in flight at snapshot time (`routes/archive.ts`,
`services/diffpatch.ts`, `services/forks.ts` untracked). Twelve SPECs + three ADRs; CI runs
typecheck/lint/tests, contract checks, the real-git e2e suite (34 passed /
35-row headless-UI allowlist), the LFS e2e job, benchmarks, and asset
determinism. See the [SPEC index](specs/),
[ADR-0002](docs/decisions/0002-contract-freeze.md) (contract freeze) and the
[runbook](docs/ops/runbook.md) (dev/deploy/bootstrap, differential/LFS e2e,
import/mirror clients, invariant checker).

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

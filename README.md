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
                 ├─ UI pages ────────▶ Hono JSX (public browse + login sessions)
                 └─ auth ────────────▶ D1 (PATs: sha256 digests, scoped)
```

Self-hosted git engine (vendored [durable-git], evolving per the split-plane design):
R2 is the blob source of truth, one Durable Object per repository serializes writes,
D1 (Drizzle ORM) holds all product metadata. No containers, no managed git service.
Deep-dive: [ADR-0001](docs/decisions/0001-technical-direction.md) ·
[reference-project survey](docs/research/tech-route-survey.md).

## Quickstart

Prerequisites: **Node ≥ 22**, **pnpm** (version from the `packageManager` field —
`corepack enable`), **git ≥ 2.22**. Wrangler itself ships as a devDependency (the
repo's scripts always invoke it via `pnpm exec`); you only need a Wrangler login
(`pnpm exec wrangler login`) for the deploy path.

### Run it locally

```bash
git submodule update --init --recursive        # gitea/ reference sources (read-only)
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # GIT_TOKEN=devtoken
pnpm db:migrate:local                          # apply Drizzle migrations to local D1
pnpm dev                                       # http://127.0.0.1:5173 — workerd, real local D1/DO/R2
```

`wrangler.jsonc` declares three required secret names (`GIT_TOKEN`,
`MIRROR_ALLOWED_HOST_LIST`, `MIRROR_CREDENTIAL_KEY`). Plain local dev — git hosting,
API, UI — needs only `GIT_TOKEN` (the example file's value); the two `MIRROR_*` keys
are read by the pull-mirror features and `pnpm test:mirror`, which preflights them
and prints the exact missing piece (recipes: [scripts/mirror-e2e.README.md](scripts/mirror-e2e.README.md)).

The users table starts empty — create the first admin and mint an all-scopes PAT
(the plaintext prints exactly once; only its sha256 digest is stored):

```bash
node scripts/bootstrap-admin.mjs <username> [email]      # local D1 by default; add --remote for production
```

Then use it like any git host — the first push **creates** the repo (private by
default; push-create, SPEC-0003):

```bash
git init myrepo && cd myrepo
git remote add origin http://<username>:<PAT>@127.0.0.1:5173/<username>/<repo>.git
git push -u origin main                                      # push = create
git ls-remote origin                                         # authenticated reads work
curl -H "Authorization: token <PAT>" http://127.0.0.1:5173/api/v1/user
```

### Deploy it

```bash
pnpm exec wrangler login
pnpm setup:deploy          # idempotent: ensures D1 cf-gitea + R2 cf-gitea-packs,
                           # fills database_id into wrangler.jsonc, applies remote migrations
                           # (read-only drift check: pnpm setup:deploy -- --check)
cd apps/worker
pnpm exec wrangler secret put GIT_TOKEN                    # dev-fallback credential
pnpm exec wrangler secret put MIRROR_ALLOWED_HOST_LIST     # mirror egress allow-list
pnpm exec wrangler secret put MIRROR_CREDENTIAL_KEY        # mirror credential KEK (32 base64 bytes)
cd ../..
pnpm db:migrate:remote     # idempotent — setup:deploy applied what existed when it ran;
                           # re-run whenever new migrations land
pnpm build && pnpm deploy  # build REQUIRED before deploy: wrangler deploys dist/ with the
                           # generated config — a stale dist carries stale wrangler state
pnpm smoke --base-url https://<your-worker>.workers.dev [--token <PAT>] [--migrate-check]
```

`pnpm smoke` (scripts/deploy-smoke.mjs, `--base-url` required) asserts `/healthz`,
that the anonymous git surface answers 401/404 (never an advert), and with `--token`
performs a real push to a throwaway private repo, confirms authenticated reads, and
fails if the **anonymous** upload-pack advert does not 401-challenge (the private-repo
read-leak regression class); it cleans the repo up afterwards. A live instance running
this path: <https://cf-gitea.hecongw.workers.dev>.

## Status

Snapshot **2026-10-25** (HEAD 72626e5); every number below is re-measurable from the
tree (`pnpm check:api`, `scripts/bench-baselines/m2.json`).

| Area | State |
|---|---|
| **Engine** | Vendored durable-git, fully landed through SPEC-0001a/0001b: smart-HTTP v0/v2 receive/serve in the Worker (fail-closed protocol parser), lease RPCs, `storage_key` R2 addressing, `pack_catalog`, lifecycle/mergeability/executeMerge RPCs, fork catalog replication. P0-hardened — the deepen-family silent-drop was eliminated structurally (parse/type/control-flow) and pinned by real-git probes + regression matrix ([P0 package](docs/design/p0-package-README.md)); SPEC-0011 ratified (two green deploys + P0 closed), M3 compaction/GC begins. m2 bench baseline (5 MiB fixture, local workerd, CI-enforced at 10%): clone 14.2 MiB/s · push 192 ms · incremental-fetch ratio 0.000245 · info/refs p50 12.5 ms |
| **API** | `/api/v1` against the frozen Gitea contract ([ADR-0002](docs/decisions/0002-contract-freeze.md)): **tier-1 terminal — 78/78 paths, 129/129 operations** (incl. webhooks/hook-deliveries, archives, diff/patch, languages); tier-2 in progress at **260/554 operations declared across 171 paths** (`pnpm check:api` PASS). Landed tier-2 families: repository extras (transfer, reviewers, issue-config, PR review threads, release assets) · issue/PR comment/label/pin writes + the issue tables (milestones, subscriptions, reactions) · organizations (identity/rename/delete, org repos, org labels) · users (table-free reads, settings, starred/follows/subscriptions, key/GPG stubs) · notifications · admin · misc/settings table-free reads + signing-key. Non-contract side surfaces (outside the frozen inventory): repo-scoped mirror migrate/sync and the >100 MB import channel |
| **UI** | Server-rendered Hono JSX (SPEC-0008 waves 1-3 + SPEC-0010): public repo browse — repo home, commit log, file view (`/src/…`, `/tree` redirects), issues + PRs lists and detail pages — plus `/login`/`/logout` PAT web sessions (`gitea_session` cookie, rotation + reuse detection). Not there yet: the write-path UI — no repo/issue creation, no settings/admin/org/user dashboards; unclaimed repo-scoped paths still answer from the API/engine |
| **Webhooks** | Hook CRUD + delivery pipeline over Queues (consumer with retries + dead-letter queue, SSRF-screened targets); the push event family is emitted from BOTH the user-push path (engine `onPush` seam) and the pull-mirror sync path through one shared builder; deliveries queryable per hook |
| **LFS** | Batch API + relay/presign store over R2, gate-intercepted routes (`/*/*/info/lfs/*`); verified by a 33-check real-`git-lfs` e2e (`pnpm test:lfs`) |
| **Mirrors** | Pull-mirror sync end to end: outbound smart-HTTP client (v0/v2), AES-GCM-encrypted source credentials, 10-minute cron producer + queue consumer, sync notifications on the push family. Egress gate defaults to https-only with private/loopback/reserved addresses and `localhost`/`.local`/`.internal` denied; `MIRROR_EGRESS_MODE=strict` narrows to an explicit allow-list. 11-scenario black-box e2e (`pnpm test:mirror`). Large history import: >100 MB chunked channel + clients (`scripts/import-client.mjs`, `import-batched-push.sh`, `mirror-import.mjs`) |
| **Verification** | Six-layer stack — workerd unit tests, golden-DOM/a11y, black-box e2e suites (real git / git-lfs / smart-HTTP source), a 20-case differential git-CLI battery, production smoke probes, CI bench baseline — with its rules recorded in [ADR-0005](docs/decisions/0005-verification-strategy.md). CI runs typecheck/lint/tests, both contract checks, the real-git e2e allowlist gate, lfs + mirror e2e jobs, benchmarks, asset determinism |

Thirteen SPECs + four ADRs; new features start with a SPEC (see the
[SPEC index](specs/README.md) for per-SPEC status). Full conventions live in
[AGENTS.md](AGENTS.md); the operator runbook (daily dev, bootstrap, e2e suites,
import/mirror clients, troubleshooting) is [docs/ops/runbook.md](docs/ops/runbook.md).

[durable-git]: https://github.com/littledivy/durable-git

# cf-gitea

The official Gitea web UI on a from-scratch TypeScript backend — Cloudflare
Workers (Hono) + D1 + R2 + Durable Objects, git smart-HTTP protocol included.
Gitea-API compatible: stock git clients (`clone`/`push`), Gitea tooling (SDKs,
`tea`, release automation, terraform providers) work against it unmodified;
the official Gitea web UI is served via the asset-reuse strategy (SPEC-0008+).
Not affiliated with the Gitea project — see [NOTICE.md](NOTICE.md).

Release notes — what shipped, how it was verified, known limitations:
[v1.0](docs/RELEASE-NOTES-v1.0.md) · [v1.1](docs/RELEASE-NOTES-v1.1.md) (the
v1.1 window drove the declared API surface to its pre-Actions/packages ceiling
and hardened storage lifecycle) · [v1.2](docs/RELEASE-NOTES-v1.2.md) (the
port-first UI endgame completed — the dispatchable survey board EMPTY — and
the full-suite verdict was redefined after the ws1009 runner-death class).

## Architecture at a glance

```
git client ──▶ Worker (Hono, edge)
                 ├─ git smart-HTTP ──▶ RepoDO (refs, leases, catalog) + R2 (packs)
                 ├─ /api/v1 ─────────▶ D1 (users, repos, issues) + engine object reads
                 ├─ UI pages ────────▶ Hono JSX (server-rendered UI + PAT login sessions)
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

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HighCWu/cf-gitea)

The button clones this repo into your GitHub account, provisions the D1
database and R2 bucket automatically (ids are filled into the wrangler config
for you), builds and deploys via Workers Builds — works on the free plan.
Zero configuration beyond the button: webhook payload URLs automatically use
your Worker's own origin (`APP_URL` stays optional — set it only when serving
behind a custom domain, or for mirror deployments whose payload URLs must name
a different public origin). One manual bit after it finishes: set the secrets
below. Then open your Worker's URL — the users table starts empty, so the
login page offers **Initialize This Instance**: create the admin account
right in the browser and you are signed in (one-shot; once any account exists
the form is gone). Regular registration stays closed unless you set
`ALLOW_SIGNUP` to `true` in your copied `wrangler.jsonc`. Prefer the
terminal? The same result, explicitly:

```bash
pnpm exec wrangler login
pnpm setup:deploy          # idempotent: copies wrangler.jsonc.example → wrangler.jsonc
                           # (gitignored, account-local) on first run, ensures D1 cf-gitea
                           # + R2 cf-gitea-packs, fills the real database_id, applies
                           # remote migrations (read-only drift check: pnpm setup:deploy -- --check)
cd apps/worker
pnpm exec wrangler secret put GIT_TOKEN                    # static dev/e2e fallback credential — PAT auth is
                                                           # the primary path; unset disables ONLY the fallback
pnpm exec wrangler secret put MIRROR_ALLOWED_HOST_LIST     # mirror egress allow-list (the two MIRROR_* secrets
                                                           # are needed only for mirror features)
pnpm exec wrangler secret put MIRROR_CREDENTIAL_KEY        # mirror credential KEK (32 base64 bytes)
cd ../..
pnpm db:migrate:remote     # idempotent — setup:deploy applied what existed when it ran;
                           # re-run whenever new migrations land
pnpm build && pnpm deploy  # build REQUIRED before deploy: wrangler deploys dist/ with the
                           # generated config — a stale dist carries stale wrangler state
pnpm smoke --base-url https://<your-worker>.workers.dev [--token <PAT>] [--migrate-check]
```

Self-hosted deployments are YOURS: nothing in this repo schedules cleanup,
deletes user data, or rate-limits beyond your own Cloudflare plan's limits —
the periodic-cleanup demo posture is a configuration of the reference
instance only, never of the code you deploy.

`pnpm smoke` (scripts/deploy-smoke.mjs, `--base-url` required) asserts `/healthz`,
that the anonymous git surface answers 401/404 (never an advert), and with `--token`
performs a real push to a throwaway private repo, confirms authenticated reads, and
fails if the **anonymous** upload-pack advert does not 401-challenge (the private-repo
read-leak regression class); it cleans the repo up afterwards. A live instance running
this path: <https://cf-gitea.hecongw.workers.dev>.

## Status

Snapshot **2026-10-28** (HEAD ea6a49d); every number below is re-measurable from the
tree (`pnpm check:api`, `docs/compat/ui-parity-survey.md`, `scripts/bench-baselines/m2.json`).

| Area | State |
|---|---|
| **Engine** | Vendored durable-git, fully landed through SPEC-0001a/0001b: smart-HTTP v0/v2 receive/serve in the Worker (fail-closed protocol parser), lease RPCs, `storage_key` R2 addressing, `pack_catalog`, lifecycle/mergeability/executeMerge RPCs, fork catalog replication. P0-hardened — the deepen-family silent-drop was eliminated structurally (parse/type/control-flow) and pinned by real-git probes + regression matrix ([P0 package](docs/design/p0-package-README.md)); SPEC-0011 ratified (two green deploys + P0 closed); M3 compaction/GC landed through its storage milestones — journal/baseline, segmented ReadGate serve, compaction, GC (SPEC-0011 §8). m2 bench baseline (5 MiB fixture, local workerd, CI-enforced at 10%): clone 14.2 MiB/s · push 192 ms · incremental-fetch ratio 0.000245 · info/refs p50 12.5 ms |
| **API** | `/api/v1` against the frozen Gitea contract ([ADR-0002](docs/decisions/0002-contract-freeze.md)): **tier-1 terminal — 78/78 paths, 129/129 operations** (incl. webhooks/hook-deliveries, archives, diff/patch, languages); tier-2 at the **pre-Actions/packages ceiling — 490/554 operations declared across 298 paths** (`pnpm check:api` PASS); the remaining 64 are FEATURE-ABSENT — Gitea Actions (54 ops) and the package registry (10 ops) need their own SPECs first ([inventory](docs/compat/api-remaining-inventory.md)). Landed tier-2 families: repository extras (transfer, reviewers, issue-config, PR review threads, release assets, generate/template, license detection, size/stars/watches/forks counters) · issue/PR writes + tables (comments, labels, pins, milestones, subscriptions, reactions, attachments) · projects boards (repo/org/user scopes) · organizations (identity, teams, labels, repos, blocks) · users (settings, emails/keys/GPG, starred/follows/subscriptions, blocks) · block enforcement at the write seams · push mirrors · tag protections · wiki (sibling engine cell) · git hooks · OAuth2 applications (CRUD) · admin · notifications · activity feeds (15 wired action types) · misc/settings table-free reads + signing-key. Non-contract side surfaces (outside the frozen inventory): repo-scoped mirror migrate/sync and the >100 MB import channel |
| **UI** | Server-rendered Hono JSX (SPEC-0008/0010 + the ui-parity waves): **92 LANDED / 4 PARTIAL / 20 ABSENT of 116 upstream page-bearing GETs** (survey tick-15, programmatic tally; per-row status in [docs/compat/ui-parity-survey.md](docs/compat/ui-parity-survey.md)). Landed: repo browse + code views (tree-list/tree-view, both code-view fragments, the render family, archive download), the full issues/PRs set incl. merge box + files ranges + compare, releases with writes + downloads, the wiki family (page/commit/raw/excerpt), projects boards + writes, creation and migration forms, the editor with live upload, labels/milestones, fork form + social lists, the entire user-settings tab family + profile strips, org members/settings tabs, the new repo-settings tabs (protected tags, git hooks, deploy keys), the admin dashboard/monitor/listings group, the global inboxes + the notifications subscriptions/watching surfaces incl. the purge-page write, the avatar seam, attachments, rss/atom feeds + sitemap — plus `/login`/`/logout` PAT web sessions (`gitea_session` cookie, rotation + reuse detection). Remaining rows are needs-API-first, Actions/packages-gated, or no-RPC-gated (blame/graph/code-search/heatmap) |
| **Webhooks** | Hook CRUD + delivery pipeline over Queues (consumer with retries + dead-letter queue, SSRF-screened targets); the push event family is emitted from BOTH the user-push path (engine `onPush` seam) and the pull-mirror sync path through one shared builder; deliveries queryable per hook |
| **LFS** | Batch API + relay/presign store over R2, gate-intercepted routes (`/*/*/info/lfs/*`); verified by a 33-check real-`git-lfs` e2e (`pnpm test:lfs`) |
| **Mirrors** | Pull-mirror sync end to end: outbound smart-HTTP client (v0/v2), AES-GCM-encrypted source credentials, 10-minute cron producer + queue consumer, sync notifications on the push family. **Push mirrors (outbound)**: CRUD + sync trigger feeding the same queue consumer, registration-time SSRF gate, `sync_state`/`next_sync_at` ledger with last-error capture ([SPEC](specs/push-mirror-outbound.md)). Egress gate defaults to https-only with private/loopback/reserved addresses and `localhost`/`.local`/`.internal` denied; `MIRROR_EGRESS_MODE=strict` narrows to an explicit allow-list. 11-scenario black-box e2e for the pull path (`pnpm test:mirror`). Large history import: >100 MB chunked channel + clients (`scripts/import-client.mjs`, `import-batched-push.sh`, `mirror-import.mjs`) |
| **Verification** | Six-layer stack — workerd unit tests, golden-DOM/a11y (67 page goldens + the structural sweeps), black-box e2e suites (real git / git-lfs / smart-HTTP source), a differential git-CLI battery, production smoke probes, CI bench baseline — with its rules recorded in [ADR-0005](docs/decisions/0005-verification-strategy.md). The suite-wide verdict is the **full-suite composite gate**, `pnpm test:full` ([ADR-0006](docs/decisions/0006-full-suite-composite-gate.md)): at the pre-strip peak workerd's ws1009 warm-module cap killed ~204 of 258 test files in a bare single pass; the strip lever (`CF_TEST_STRIP_SOURCEMAPS=1`) removed that byte family, so the gate's phase 1 is single-pass again — two perfect passes at **261 files / 5,831 tests / 0 failed** at the RD21 deploy gate — with `--solo` retained as the safety net, and the structural upstream cure still desired ([#16515](https://github.com/cloudflare/workers-sdk/issues/16515); community PR [#16523](https://github.com/cloudflare/workers-sdk/pull/16523) proposes the chunked-frames fix, pending maintainer triage). Plain `vitest run` / `pnpm test` is the fast local loop for a file or scope only — never cited as "full suite green". CI runs typecheck/lint, the composite gate (evidence uploaded), both contract checks, the real-git e2e allowlist gate, the differential battery, lfs + mirror e2e jobs, benchmarks (10% regression gate enforced), asset determinism |

Twenty SPEC documents + five ADRs; new features start with a SPEC (see the
[SPEC index](specs/README.md) for per-SPEC status). Full conventions live in
[AGENTS.md](AGENTS.md); the operator runbook (daily dev, bootstrap, e2e suites,
import/mirror clients, troubleshooting) is [docs/ops/runbook.md](docs/ops/runbook.md).

[durable-git]: https://github.com/littledivy/durable-git

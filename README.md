# cf-gitea

The official Gitea web UI on a from-scratch TypeScript backend — Cloudflare
Workers (Hono) + D1 + R2 + Durable Objects, git smart-HTTP protocol included.
Gitea-API compatible: stock git clients (`clone`/`push`), Gitea tooling (SDKs,
`tea`, release automation, terraform providers) work against it unmodified;
the official Gitea web UI is served via the asset-reuse strategy (SPEC-0008+).
Not affiliated with the Gitea project — see [NOTICE.md](NOTICE.md).

**Demo**: <https://cf-gitea-demo.aiapp.run> **(live)** — the shared reference
instance; it wipes content on a 72-hour sweep, a posture of that deployment
only (what you deploy yourself has none of it — see [Deploy it](#deploy-it)).

**Deploy**: to your own Cloudflare account in one click — see
[Deploy it](#deploy-it) (the button provisions D1 + R2; the first browser
visit initializes your admin).

Release notes — what shipped, how it was verified, known limitations:
[v1.0](docs/RELEASE-NOTES-v1.0.md) · [v1.1](docs/RELEASE-NOTES-v1.1.md) (the
v1.1 window drove the declared API surface to its pre-Actions/packages ceiling
and hardened storage lifecycle) · [v1.2](docs/RELEASE-NOTES-v1.2.md) (the
port-first UI endgame completed — the dispatchable survey board EMPTY — and
the full-suite verdict was redefined after the ws1009 runner-death class) ·
[v1.3](docs/RELEASE-NOTES-v1.3.md) (the engine read family + the combined UI
wave closed ten gap-census rows in one coherent-tree landing — blame,
raw/media byte serving, explore organizations, the owner heatmap, the org
dashboard/inbox surfaces, the Activity pulse — with the audit-events model,
migration 0038, and SPECs 0015–0018 ratified; the notes' appended extension
carries the day's second half — the wiki twin's full git-HTTP arc, the
packages registry's run from model to maven, SPEC-0019's federation search,
SPEC-0012's gate lift + M1a control plane, and the survey's climb to
113/1/2).

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
`corepack enable`), **git ≥ 2.22**. Wrangler itself ships as a devDependency of
`apps/worker` (the repo's scripts always invoke it through the workspace); you
only need a Wrangler login (`pnpm --filter cf-gitea-worker exec wrangler login`)
for the deploy path.

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

On a flaky network the `gitea/` submodule fetch (the first quickstart command)
can fail transiently mid-stream (curl 92 / HTTP/2 CANCEL); git's built-in
per-submodule retry usually recovers — if the clone errors, just re-run
`git submodule update --init --recursive` (observed and re-verified in the
[fresh-clone proof](docs/reviews/fresh-clone-proof-2026-10-28.md)).

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
pnpm --filter cf-gitea-worker exec wrangler login
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

Snapshot **2026-10-30** (HEAD 48d4929); every number below is re-measurable from the
tree (`pnpm check:api`, `docs/compat/ui-parity-survey.md`, `scripts/bench-baselines/m2.json`).
This table counts LANDED surface only — in-flight and SPEC'd items are named
as such (the pipeline lives in the [SPEC index](specs/README.md) and the
[census landing ledger](docs/compat/ui-gap-census-2026-10-29.md)).

<!-- v1.3 final: HEAD re-pinned at 4a45370; check:api PASS (500 ops /
     306 paths, tier-1 78/78 paths / 129/129 ops); the final survey tick
     is tick-21 (115/1/0 at 6bf9c17). -->
<!-- v1.3.1 final: HEAD re-pinned at d7441ad; check:api PASS (500 ops /
     306 paths, tier-1 78/78 paths / 129/129 ops — re-run at 48d4929,
     counts unchanged from v1.3); the final survey tick is NOT RE-WALKED this window — tick-21 (115/1/0 of 116 at 6bf9c17) stands as the last programmatic walk; the v1.3.1 window adds no new page rows (its mounts ride landed rows) so the counts carry
     (tick-21 read 115/1/0 of 116 at 6bf9c17, before this window's
     mounts). -->

| Area | State |
|---|---|
| **Engine** | Vendored durable-git, fully landed through SPEC-0001a/0001b: smart-HTTP v0/v2 receive/serve in the Worker (fail-closed protocol parser), now covering the wiki twin at `{repo}.wiki.git` (clone AND push through the parent's ACL; the sibling cell rides the main lifecycle — rename/transfer carry, delete tombstone, purge cascade), lease RPCs, `storage_key` R2 addressing, `pack_catalog`, lifecycle/mergeability/executeMerge RPCs, fork catalog replication; the receive entry re-binds its repo by name (the `bindRepo` key-guard, `2a8de93` — a refactor had silently dropped the engine's only `meta.repo` binding site, so a no-preflight push to a never-fetched cell staged packs at the unreachable `repos//` prefix; the guard makes that structurally impossible). P0-hardened — the deepen-family silent-drop was eliminated structurally (parse/type/control-flow) and pinned by real-git probes + regression matrix ([P0 package](docs/design/p0-package-README.md)); SPEC-0011 ratified (two green deploys + P0 closed); M3 compaction/GC landed through its storage milestones — journal/baseline, segmented ReadGate serve, compaction, GC (SPEC-0011 §8). SPEC-0015's read family is COMPLETE at the boundary — `grep` (exact/words/regexp; the regexp arm a step-counted NFA so catastrophic patterns answer linearly; budgets 2000 files / 50 results / 200k scan steps / 2M expansions; real-git oracle), `activityStats` and `contributorStats` (first-parent folds with per-author add/del, oracle-pinned vs real git), `scanLfsPointers` (M3 — the size-gated candidate scan over flattenTree feeding the LFS settings pages) — plus the blame boundary RPC (the DO's blame machinery exposed, real-git oracles) and the SPEC-0017 `graphData` RPC (multi-tip walk with in-DO lane assignment, the commit-graph page's engine). The v1.3.1 window's git-HTTP posture: deploy-key credentials admitted (`85fa2ff` — `gdt_` tokens ride Basic auth as the actor for their own repo's code+wiki units at the key's mode) and the Basic realm switched to upstream's OAuth2-disabled shape, ending GCM's doomed OAuth2 round-trip; the dispatcher admits the slashed wiki URLs upstream itself emits (`8fdee92`). m2 bench baseline (5 MiB fixture, local workerd, CI-enforced at 10% with calibrated absolute floors on the wall/rate legs — clone wall floor 2,000 ms / 5 MiB/s after a measured 4.5× cross-runner noise band): clone 14.2 MiB/s · push 192 ms · incremental-fetch ratio 0.000245 · info/refs p50 12.5 ms |
| **API** | `/api/v1` against the frozen Gitea contract ([ADR-0002](docs/decisions/0002-contract-freeze.md)): **tier-1 terminal — 78/78 paths, 129/129 operations** (incl. webhooks/hook-deliveries, archives, diff/patch, languages); tier-2 — **500/554 operations declared across 306 paths** (`pnpm check:api` PASS, re-run at this snapshot); the remaining 54 are FEATURE-ABSENT — Gitea Actions (54 ops, SPEC-0012's wave: the control plane M1a is landed, the `/api/v1` management ops ride the in-flight milestones); the package registry's ten contract ops are DECLARED ([SPEC-0016](specs/0016-packages.md) — the nine management ops + admin list + the generic PUT/GET/HEAD/DELETE protocol at `/api/packages`, with the pypi/helm/npm/maven/nuget protocol families mounted beside it — M5b nuget landed at `e26c862`, the registry carries SIX protocols) ([inventory](docs/compat/api-remaining-inventory.md)). Landed tier-2 families: repository extras (transfer, reviewers, issue-config, PR review threads, release assets, generate/template, license detection, size/stars/watches/forks counters) · issue/PR writes + tables (comments, labels, pins, milestones, subscriptions, reactions, attachments) · projects boards (repo/org/user scopes) · organizations (identity, teams, labels, repos, blocks) · users (settings, emails/keys/GPG, starred/follows/subscriptions, blocks) · block enforcement at the write seams · push mirrors · tag protections · wiki (sibling engine cell) · git hooks · OAuth2 applications (CRUD) · packages (SPEC-0016: the generic protocol + pypi/helm/npm/maven/nuget — six protocols) · admin · notifications · activity feeds (14 wired action types) · misc/settings table-free reads + signing-key. The v1.3.1 convergence window closed the api/auth/packages parity drifts: token scopes gate the whole `/api/v1` tree (a scopeless or `read:user`-only token now 403s the gated writes — `56109ec`); the release family is whole (a fresh `tag_name` auto-creates its git tag `6b2bedc`, every published edit re-runs createTag `29ecd1d`, `sha1`/`num_commits`/`created` fill from the tagged commit `efd1916`); the user serializers render row truth (self follower/following counts `40120ae` with the no-binding degrade arm `9f883d0`, stored topics/licenses `58283bd`, the `username` runtime compat key + the self-viewer trio `cf269f4`, the profile quartet `a5936fe`); `assigned_by` rides both assignee list arms (`4f8ade7`); repoEdit stores its fifteen PR merge-config fields (`7047639`); the issue/pull family honors the unit gates (`ddf3b2a`); comment bodies are required 422 and locked issues 403 non-writers (`d2fd6f0`); the PR merge surface accepts upstream's PascalCase casing and composes the default messages (`2854fb4`); the packages registry answers upstream's semantics (duplicates 409 always + chunked unknown-length uploads stream + the pypi integrity gate closed `3571fe8`, the nuget service index unauthenticated + byte-exact quota sentinels + upstream byte-serving on the download arms `41eada6`, the pypi UTF-8 multipart decode `2757a9e`). Non-contract side surfaces (outside the frozen inventory): repo-scoped mirror migrate/sync and the >100 MB import channel |
| **UI** | Server-rendered Hono JSX (SPEC-0008/0010 + the ui-parity waves): **115 LANDED / 1 PARTIAL / 0 ABSENT of 116 upstream page-bearing GETs** (no re-walk this window — the v1.3.1 window adds no new page rows, its mounts ride landed rows; the last programmatic re-walk is tick-21 at HEAD `6bf9c17`: 115/1/0 of 116, zero rows in flight — the v1.3 window completed the actions family: the repo actions pages through the F-row tails, the repo/org/user settings actions tabs incl. Runners twins and the ActionsConfig-backed general sections, the admin actions runners/variables pages, and the org settings Packages cleanup-rules page; the one PARTIAL row is the admin auths page, needs-API-first per SPEC-0018; the row→commit mapping is the [census landing ledger](docs/compat/ui-gap-census-2026-10-29.md), per-row status in [docs/compat/ui-parity-survey.md](docs/compat/ui-parity-survey.md)). Landed: repo browse + code views (tree-list/tree-view, both code-view fragments, the render family, archive download), the full issues/PRs set incl. merge box + files ranges + compare + the issues/new/choose redirect + the comment-attachments fragment, releases with writes + downloads, the wiki family (page/commit/raw/excerpt), projects boards + writes, creation and migration forms, the editor with live upload, labels/milestones, fork form + social lists, the entire user-settings tab family + profile strips, org members/settings tabs, the new repo-settings tabs (protected tags, git hooks, deploy keys), the admin dashboard/monitor/listings group, the global inboxes + the notifications subscriptions/watching surfaces incl. the purge-page write, the avatar seam, attachments, rss/atom feeds + sitemap — and the v1.3 combined wave: the blame page (over the engine blame RPC, with the file-view Blame anchor), the raw/media byte families with LFS pointer resolution (the pasted-URL shapes upstream serves; links switched to upstream's web form), explore organizations, the owner heatmap JSON route + profile widget, the org dashboard and the org issues/pulls/milestones inbox (member-gated, team arms), the repo Activity pulse page over the engine stats RPC, org settings applications, the admin emails/hooks/badges/applications pages, and the fork grammar on compare (two-dot DirectComparison + head-side fork forms), then the tick-17 registration window (the repo + org settings audit-log pages over the audit-event store, the in-repo search page over the grep RPC, the three activity chart pages + their `/data` JSON routes) and the post-tick four-arm window (the admin config summary, the commit-graph page over `graphData`, the four read-only LFS settings pages over `scanLfsPointers`, the content-history soft-delete arm, the per-page `PageData` config channel through the shell), the packages family (the user packages page + the repo tab — list/versions/view/file-download over the registry APIs), and the federation code-search pages (explore + user code over the SPEC-0019 loader) — plus `/login`/`/logout` PAT web sessions (`gitea_session` cookie, reuse detection; rotation decoupled onto its own 24h clock and the validity clock idle-sliding — 24h idle, 31 days with remember, `69036c8`), the first-run `/install` window and the `ALLOW_SIGNUP`-gated `/user/sign_up` registration (SPEC-0010 §6). The v1.3.1 window's mounts and posture (counted at the final tick): the user-scope Packages settings twin (`74df9ad`), the `/api/swagger` page beside the static block serving both upstream JSON arm names from the live registry document (`c69f901`), the web archive POST arm upstream's bundle speaks (`4e6d1cc`) with the serving brought to git-archive semantics — `.gitattributes` export-ignore honored on the walk, zip entries DEFLATE (`5365236`), the repo header's Wiki tab + the Watch/Star/Fork trio + the file-view LFS badge (`f561d92`; the slashed wiki URLs upstream emits reach the sub-app again, `8fdee92`), the pulls list's New Pull Request button threaded through real collaborator write grants (`d52361b`, `56df8a6`), the empty-repo page's writer/anonymous branching (`d52361b`, pins `9c4c71a`), the branches page's commit-time sort (`7f9241e`), the cron monitor's full seven-arm census with per-arm tick state (`64ebfa9`), and the link crawl's dead-link fixes (`b6abd2a`); posture: the security-headers layer (`cebefa0`), the signup/login token-flow disclosure (`058d76e`), the demo quota enforced on the web create path (`65f95f1`), the packages cleanup-rule gate un-tautologized (`f8362b1`), the `/user/settings` serial-D1 collapse (`06b3384`). Remaining rows: zero ABSENT since tick-20 — the actions subsystem completed across the tick-19/tick-20 windows (the settings/actions E row at tick-19, the repo actions F row's six tail GETs at tick-20; tick-21 flipped nothing). The one PARTIAL row is the admin group: every arm serves except the auths page — [SPEC-0018](specs/0018-admin-config-notices-auths.md)'s documented omission verdict; the actions surfaces themselves are landed (the admin runners/variables pages `b5923ed`, the org/user runners twins `3ab7532`/`72af05a`), with the recorded bare-redirect/general/scoped-workflows reductions inside LANDED rows |
| **Webhooks** | Hook CRUD + delivery pipeline over Queues (consumer with retries + dead-letter queue, SSRF-screened targets); the push event family is emitted from BOTH the user-push path (engine `onPush` seam) and the pull-mirror sync path through one shared builder; deliveries queryable per hook; **23/26 upstream wire event types fully emitted, zero partial rows** ([coverage audit](docs/compat/webhook-event-coverage.md)) |
| **LFS** | Batch API + relay/presign store over R2, gate-intercepted routes (`/*/*/info/lfs/*`); verified by a 33-check real-`git-lfs` e2e (`pnpm test:lfs`). The web `media`/`raw` byte families resolve LFS pointers to content through the store, and the four LFS settings pages read through the landed `scanLfsPointers` RPC (SPEC-0015 M3 — complete, the settings family landed at `9d7ccd6`). The file-locking family is LIVE (upstream-exact, `7b589c7`: list/create/verify/unlock over migration 0045's `lfs_locks` table — 415-before-auth media-type checks, the `gitea-lfs` realm with route-specific anonymous bodies, page-number cursors with upstream's 0/1-alias quirk, the bug-compatible unlock arm; the old 501 retired; 17 new locks tests, the family 116/116), and the batch/upload/verify envelopes drop the trailing newline to match the pin's compact bytes (`95cdcaf`) |
| **Mirrors** | Pull-mirror sync end to end: outbound smart-HTTP client (v0/v2), AES-GCM-encrypted source credentials, 10-minute cron producer + queue consumer, sync notifications on the push family. **Push mirrors (outbound)**: CRUD + sync trigger feeding the same queue consumer, registration-time SSRF gate, `sync_state`/`next_sync_at` ledger with last-error capture ([SPEC](specs/push-mirror-outbound.md)). Egress gate defaults to https-only with private/loopback/reserved addresses and `localhost`/`.local`/`.internal` denied; `MIRROR_EGRESS_MODE=strict` narrows to an explicit allow-list. 11-scenario black-box e2e for the pull path (`pnpm test:mirror` — 93 checks / 0 failed, three consecutive runs at the v1.2 close). Large history import: >100 MB chunked channel + clients (`scripts/import-client.mjs`, `import-batched-push.sh`, `mirror-import.mjs`) |
| **Verification** | Six-layer stack — workerd unit tests, golden-DOM/a11y (82 goldens — 79 HTML pages + 3 RSS envelopes — + the structural sweeps), black-box e2e suites (real git / git-lfs / smart-HTTP source), a differential git-CLI battery, production smoke probes, CI bench baseline — with its rules recorded in [ADR-0005](docs/decisions/0005-verification-strategy.md). The suite-wide verdict is the **full-suite composite gate**, `pnpm test:full` ([ADR-0006](docs/decisions/0006-full-suite-composite-gate.md)): at the pre-strip peak workerd's ws1009 warm-module cap killed ~204 of 258 test files in a bare single pass; the strip lever (`CF_TEST_STRIP_SOURCEMAPS=1`) removed that byte family, so the gate's phase 1 is single-pass again — two perfect passes at **261 files / 5,831 tests / 0 failed** at the RD21 deploy gate — with `--solo` retained as the safety net, and the structural upstream cure still desired ([#16515](https://github.com/cloudflare/workers-sdk/issues/16515); community PR [#16523](https://github.com/cloudflare/workers-sdk/pull/16523) proposed the chunked-frames fix — bot-closed under the unvouched-collaborator policy 2026-10-27, pending maintainer triage). Plain `vitest run` / `pnpm test` is the fast local loop for a file or scope only — never cited as "full suite green". CI runs typecheck/lint, the composite gate (evidence uploaded), both contract checks, the real-git e2e allowlist gate, the differential battery, lfs + mirror e2e jobs, benchmarks (10% regression gate enforced), asset determinism — the **first fully green run** is [40726243702](https://github.com/HighCWu/cf-gitea/actions/runs/40726243702) (HEAD 60c65e1): all seven jobs success, including the full-suite composite gate and the calibrated benchmark gate's first armed compare at the bumped runtime (workerd 1.20261023.1). **Deployed reality (RD25 dep-bump window, 2026-10-28, live version `fb654a8b`)**: the window bumped five exact deps (hono 4.13.14 · wrangler 4.153.0 · @cloudflare/vitest-plugin 1.4.8 · typescript-eslint 8.72.1 · @cloudflare/workers-types 5.20261027.1), moved the miniflare override to 5.20261023.0-beta (workerd 1.20261023.1) and both `compatibility_date`s to 2026-10-23, and the composite gate PASSED at the bumped runtime — **268 files / 268 direct, zero solo needed / 0 deaths / 127.7 s** (the RD24b freeze read 266 direct + 2 solo-green / 150.9 s); migrations stand at 0036+0037 applied remote (RD25 schema-silent), and the live probe batteries read **standing nine 113/0 · branch-protection 18/0 · fixwave-parity 22/0 (the `fw-org-member-preaccess` discriminator green, held since its RD24b first-green) · demo 2/1-posture/1-info** against the running demo at <https://cf-gitea-demo.aiapp.run> (healthz 200 on both surfaces) — every number quoted from the REDEPLOY25 block in [docs/design/p0-evidence.md](docs/design/p0-evidence.md). The v1.3 window hardened the gate tooling itself: the staged-state commit guard (`scripts/verify-commit.mjs` — verifies exactly what a pathspec commit would land, via temp-index plumbing + an isolated worktree running real tsc; born from the swept-snapshot incident chain, [release notes §2](docs/RELEASE-NOTES-v1.3.md)), calibrated absolute floors on the bench's clone wall/rate legs (`9db02ab`), and the golden-harness clock pins (seed-day `created_at` under the T0 pin, `7ba1ed6`). The v1.3.1 convergence record re-ran the affected surface whole in a detached worktree pinned at `29ecd1d` — **98 suites / 2,551 results, 0 failed**, every Tests line from the verification's own runs (`635a573`) — and its two recorded coverage gaps closed in-window (the archive POST arm's pins `e9a6595`, the counts degrade arm's dedicated pin `93e9c0b`) |

**Gitea Actions** ([SPEC-0012](specs/0012-actions-feasibility.md), accepted
2026-10-29 with its demand gate lifted) is under way, counted only where landed:
the control plane (M1a, `32ef8bf`) is in — `Register`/`Declare`/`FetchTask`/`Ping`
mounted as connect-RPC procedures with the dispatch CAS, migration 0041's twelve
tables, the wire freeze hash-verified against upstream's actionslib v1.5.0, and a
fake-runner oracle speaking real connect/proto against the mounted app. M1b (task
updates, the log-chunk protocol, artifacts v4-then-v1, the OIDC issuer; `10cfb97`)
and the Actions UI family are landed, the always-on sweeps ride the standing
crons (zombie stop `3bc5d29`; endless/abandoned/ephemeral `e4b9f66`) beside the
opt-in `ACTIONS_*_RETENTION_DAYS` vars (`3bc5d29`), and the self-host guide is
landed as [docs/guide/actions-runners.md](docs/guide/actions-runners.md) (M2) —
a stock `act_runner` registers against your instance. The v1.3.1 parity
pass fixed the real-runner drifts: the OIDC audience/subject are byte-exact
with upstream (the malformed `https://hostowner` audience and the
repo-name-interpolated subject gone, `e3b55a8`), the dispatch scan no longer
breaches D1's 100-bind ceiling at any repo count (`e3b55a8`), and
`UpdateTask` answers the 60s cancelling handshake with upstream's
CANCELLING→CANCELLED map, the terminal stopTask carrying its piggybacked
cleanup (`e4b9f66`). Execution never runs in
the Worker: per upstream's architecture, runners are self-hosted. Still absent:
the trigger chain (M3) — nothing creates runs from pushes yet — and the
`/api/v1` runner-management ops (SPEC-0012 §2.8).

Twenty-six SPEC documents + five ADRs; new features start with a SPEC (see the
[SPEC index](specs/README.md) for per-SPEC status). Full conventions live in
[AGENTS.md](AGENTS.md); the operator runbook (daily dev, bootstrap, e2e suites,
import/mirror clients, troubleshooting) is [docs/ops/runbook.md](docs/ops/runbook.md).

## License

cf-gitea's own code is [MIT](LICENSE). The Gitea web frontend submodule and the
adapted durable-git engine keep their upstream licenses and attributions — see
[NOTICE.md](NOTICE.md).

[durable-git]: https://github.com/littledivy/durable-git

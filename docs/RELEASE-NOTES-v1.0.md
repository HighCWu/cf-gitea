# cf-gitea v1.0 — Release Notes

Snapshot 2026-10-25, HEAD `af9b1b5` (the v1.0 build-out: 227 commits since
2026-10-24, from the workspace scaffold `ab61b5a` to the freeze-deploy evidence
`af9b1b5`). Every number below is either re-measured from this tree this run
(marked **measured**) or anchored to the commit that recorded it.

---

## 1. What v1.0 is

cf-gitea is a **Gitea-compatible, headless git forge running entirely on
Cloudflare's developer platform**: D1 for relational metadata, R2 for git blobs,
one Durable Object per repository serializing writes, Queues for webhook
delivery and background work — no containers, no managed git service
(ADR-0001, `5233dfc`). Stock git clients (`clone`/`push`, shallow, LFS), Gitea
API tooling (SDKs, `tea`, terraform providers) work against it unmodified; the
official Gitea web UI is the long-term frontend via the asset-reuse strategy
(`gitea/` submodule pinned read-only, `2cea5ce`; UI server-rendered by Hono JSX
until SPEC-0008+).

### Capability table

| Capability | State at v1.0 | Anchors |
|---|---|---|
| **Git smart-HTTP v0/v2** | `/info/refs` + `git-upload-pack`/`git-receive-pack` in the Worker against R2/DO; push-create (first push creates the repo, private by default); ACL matrix gate over the git and repo-scoped engine surface; gzip caps; go-get. Protocol parser is fail-closed, advert advertises only parsed-and-handled capabilities (`36236af`). | `419c811` (gate M1), `f052c64` (lifecycle/redirects/push-create), `6c7ce18`+`102762a` (receive/serve data plane), `70c9c3d` (engine-path ACL widening) |
| **P0-hardened shallow semantics** | The deepen family (`--shallow-since`, `--shallow-exclude`, `deepen-relative`) is **rejected with a protocol-shaped ERR — never a silent full clone** — eliminated structurally at parse/type/control-flow (cache path unreachable for rejected negotiation) and pinned by 16/16 parse-matrix checks, a 15-check cache-unreachability gate, real-git dev probes (7/7) and production probes (3/3, unchanged-green across three deployments). | `docs/design/p0-evidence.md`; `e361710` (gates G1–G5), `102762a`, `d3d57ab`, production close-out in `af9b1b5` |
| **REST API `/api/v1`** | **302 of 554 frozen-contract operations declared across 194 paths** (measured this run: `node scripts/check-openapi.mjs` PASS at `af9b1b5`; contract total 554 per tag: repository 229, user 98, organization 88, issue 72, admin 33, miscellaneous 14, package 9, notification 7, settings 4). **Tier-1 is terminal: 78/78 paths, 129/129 operations** (`dcb422f`). Tier-2 families landed via one REG commit each: repo extras 19 (`89f6f1b`/`8928f04`), issue tables 17 (`4bb3c26`/`0473d58`), notifications 7 (`2c69209`/`92ea66f`), admin 8 (`71f0b7c`/`a618b7c`), org labels 5 (`4211503`/`e281e53`), misc/user table-free reads 15 (`99efa92`/`b5caa17`), misc tier-3 7 (`497c973`), issue attachments 10 (`bb909c7`/`f31e1e9`), **org teams 20** (`c8c47af`/`96e8625`), user emails/keys/GPG 10 (`822172b`), server-driven migrate (`0fe6b04`). Contract frozen against the pinned upstream swagger (ADR-0002, `83bffad`/`88bf7a3`). | see left |
| **Web UI (server-rendered)** | Public browse: repo home (code tree + README), commit log, file view + `/tree` redirects, issues/PRs lists and detail pages, PR files diff (`9b35c71`, `7e1d22b`, `6fe81f2`, `dc66079`). Authed writes: login/logout PAT web sessions with `gitea_session` cookie, rotation + reuse detection (`89698b4`, `baddcde`); new issue, settings/hooks slice (`0d7d68d`); comment/close/label writes (`dc66079`); org home + repo milestones (`694c55f`); user profiles (`0cdc46a`); **web file editor** (new/edit/delete) (`8adc6cf`). Production dispatcher fix so UI write POSTs route correctly (`1c8b442`). Golden DOM + a11y verification (`9865b1d`). | see left |
| **Webhooks** | **18 of the 26 upstream wire event types fully emitted (69%); 0 types have the feature present but the webhook missing; the remaining 8 are N/A because the triggering feature itself is absent** (reviews, wiki, packages, Actions — see limitations). Hook CRUD + per-hook delivery queries (`4744cdd`), delivery pipeline over Queues with retries, dead-letter queue and SSRF-screened targets (`7d8e0e7`, envelope fix `98e1f9f`), user pushes emit through the engine `onPush` seam (`fff6094`), one shared payload builder dedupes the user-push and mirror paths (`55f1e99`). Coverage audited against the upstream pin: `docs/compat/webhook-event-coverage.md` (`6001142`, refresh `9410fde`). | see left |
| **Git LFS** | Batch API + relay/presign store over R2, gate-intercepted `/*/*/info/lfs/*` routes (`81d9a67`, service `db6b5fb`, pointer lib `7ea138f`). Verified by a 33-check real-`git-lfs` e2e through the relay (`0e48e77`; CI job `b50d2c8`). | `pnpm test:lfs` |
| **Mirrors + imports** | Pull-mirror sync end to end: outbound smart-HTTP client v0/v2 with real-wire parsing fixes (`2278fc6`), AES-GCM-encrypted source credentials, 10-minute cron producer + queue consumer, sync notifications on the push family (`61aceb5`), egress gate defaulting to https-only with private/loopback/reserved denied and an `MIRROR_EGRESS_MODE=strict` allow-list mode. 11-scenario black-box e2e against a real loopback `git upload-pack` (`a38f92e`). Large-history import: **server-driven migrate** `POST /repos/migrate` (`0fe6b04`), import-from-URL producer (`ab56ec9`), and the >100 MB chunked import channel + clients (`09132c1`). | `pnpm test:mirror` |
| **Orgs, teams, ACL** | Organizations as first-class rows (org tables migration `631e3b9`, services `4495f3c`, tier-2 identity/rename/delete `9c4b64e`); **teams** — 20 ops + `team_members`/`team_repo_access` tables (`c8c47af`/`96e8625`); team grants enforced at every seam — visibility/permissions, git-HTTP, org-repo create, delete cascade (`9e23010`), ownership guards narrowed to `isOrgOwner` (`94cd19e`), team-ACL happy paths tested (`cc881e4`). | SPEC-0007 |
| **Sessions** | PAT login for the web UI: `id:secret` cookie, server-side `sessions` table (migration 0013), rotation + reuse detection, viewer extension for the render path (`89698b4`, mount `baddcde`). | SPEC-0010 (`ae89563`) |
| **Storage engine** | Vendored [durable-git] evolved through the split-plane design: receive-in-Worker streaming into R2 staging, `storage_key` addressing, `pack_catalog`, lifecycle/mergeability/executeMerge RPCs, fork catalog replication (`59a0776`, `893d3c9`, `3b30ba3`, `0223dcb`, `8fb87a2`). **Compaction/GC milestones M3.0–M3.4 complete**: M3.0 DO schema migrations (`eab5cf2`), M3.1 **read leases** (`da1c2fb`), M3.2 **segmented serve** with per-segment lease renewals (`e359e44`), M3.3 **compaction** — lease-gated merge, single-txn publish, RETIRED serves readers (`0303f5d`), M3.4 **GC** — RETIRED→RECLAIMABLE→DELETED with lease-gated deletion and the closing counter-example check (`b4bab63`). As-built in SPEC-0011 (`968f4c8`, `dc49de5`, `934d5a9`, `53fc835`), ratified on the M2 stability gate (`72626e5`). M3.5 (fault-injection matrix + generated capability matrix) remains the acceptance-hardening tail. | SPEC-0011 |

---

## 2. Verified-by: the six-layer verification stack (ADR-0005, `9a2dd43`)

Headline numbers, per layer (ADR-0005 records the rules each layer bought):

1. **Unit — vitest in workerd** (`@cloudflare/vitest-plugin`, real local
   D1/R2/DO bindings): **2153 passed / 5 skipped across 92 files in 99.6 s** at
   the freeze tree `a2ecd92` — the first fully green full-suite run (deploy-gate
   record, `af9b1b5` in `docs/design/p0-evidence.md`; lineage 1540 → 1854 at
   `bde4cb1` → 2153). `tsc --noEmit` is its own mandatory gate — 0 errors at the
   freeze (ADR-0005 D2).
2. **Golden DOM + a11y**: byte-exact committed goldens through the real route
   path plus an accessibility smoke over the served bytes (`9865b1d`).
3. **Black-box e2e, real clients**: the vendored real-git engine suite — 69
   checks, CI asserts the failure set stays **exactly the documented 35-row
   headless-UI allowlist** (`.github/workflows/ci.yml`; allowlist evolution
   32→34 passing recorded in ADR-0001's annex, `59a0776`); LFS — 33 checks with
   a real `git-lfs` client (`0e48e77`); mirrors — 11 scenarios against a real
   loopback smart-HTTP source (`a38f92e`).
4. **Differential git-CLI battery** (`pnpm diff:test`): **20 cases** (measured
   this run: 7 protocol + 6 read + 4 write + 3 push in `scripts/diff-cases/`),
   same deterministic repos and commands against ours and optionally theirs,
   every divergence must satisfy a declared rule; CI job with **no allowlist**
   (`c114209`). The deepen-strict-reject case pins the P0 property on the wire
   (`ec5f7c9`).
5. **Production probes** (`pnpm smoke`, `scripts/deploy-smoke.mjs` `ea4ef95`):
   at the v1.0 deployment **6 pass / 0 fail / 1 skip** — healthz, anon git
   surface, real push + authed ls-remote + anonymous advert 401-challenge,
   migrate-check (19 expected tables), cleanup (`af9b1b5`). The P0 shallow
   probes re-run green (3/3, exit codes + `.git/shallow` verdicts) against **all
   three** production deployments.
6. **CI bench baselines** (`scripts/bench-baselines/m2.json`, recorded
   `eb01ed1`): m2 milestone, 5 MiB fixture, local workerd — **clone 14.2 MiB/s ·
   push 192 ms · incremental-fetch ratio 0.000245 · info/refs p50 12.5 ms**;
   CI fails the build on >10% regression. **First production bench** (`af9b1b5`):
   clone 7799.82 ms (0.69 MiB/s, 5,694,917 B received) · push 2072.22 ms ·
   fetch incremental ratio 0.00025 · info/refs p50 382.84 ms / p95 562.98 ms —
   explicitly **not baseline-comparable** (network RTT/TLS; report-only).

Plus the engine's standalone gates: **12 tsx check scripts, 223 checks, all
green** (measured this run by listing `packages/git-engine/e2e/check-*.mjs`;
total as-built in SPEC-0011, `53fc835`) — deepen-parse 16/16, cache
unreachability 15 (mutation-tested), fork replication 50, migrations 17,
read leases 20, segmented serve 10, compaction 8, GC 8, merge graph/tree/engine
14/25/29, catalog RPC 10. Contract checks: `pnpm check:api` PASS (above) and
`pnpm check:contract` PASS (frozen swagger sha verbatim).

---

## 3. Known limitations (honest list)

- **Feature families not built** — the webhook audit's N/A rows
  (`docs/compat/webhook-event-coverage.md`): **PR code reviews** (no
  approve/reject routes exist; the four `pull_request_review*` event types are
  N/A), **wiki**, **package registry**, and **Gitea Actions**
  (`workflow_run`/`workflow_job`/`schedule`). Actions exists only as
  **SPEC-0012's gated draft** (`cb3149f`): research-only, with a verified
  surface inventory; nothing is built until its §1.1 entry criteria fire
  (a concrete CI demand + a committed runner operator + a real act_runner wire
  capture). A user pushing `.gitea/workflows/*.yml` gets a repo that silently
  ignores them.
- **Git over HTTPS only.** The SSH protocol is not possible on Workers
  (ADR-0001); Spectrum or a container would be required if SSH is ever needed.
- **Single-region posture.** The repository Durable Object's `locationHint` is
  pinned to the R2 bucket region and D1 is a single database; cross-region
  clients pay the DO RTT, mitigated by the 60 s edge refs cache keyed on
  `refs_version` (SPEC-0001 risk T4).
- **UI degradations** (SPEC-0008 §3.3–3.4): code fences render as plain
  `<pre><code>` — **no syntax highlighting**, no mermaid/katex; non-markdown
  READMEs render plain-text; markdown rendering caps at 512 KiB; **blame is
  deferred entirely** (no data source). The write-path UI is still partial: no
  repo-creation UI, no admin/org/user dashboards; unclaimed repo-scoped paths
  still answer from the API/engine.
- **workers-types / R2 platform gap**: the R2 binding has no server-side copy
  (pinned `@cloudflare/workers-types`; workerd#1349), so fork replication uses
  worker-mediated streaming copies — recorded in
  `packages/git-engine/NOTICE.md` (`0223dcb` wave).
- **Quota/limits posture**: the edge rejects bodies over the empirical ~110 MiB
  proxy limit with 413 (`e28380b`) — larger histories must use the >100 MB
  chunked import channel (`09132c1`); CPU is capped (5-min maximum per request;
  `ctx.waitUntil` extends only 30 s past the response; sub-hour crons get 30 s
  CPU so crons enqueue and queue consumers do the work — recorded `008ca9d`).
  Availability under GC is **explicitly not promised** in v1: the design
  chooses safety (Property A — a completed fetch is complete and parseable;
  lease failure is never reported as success; ADR-0005, SPEC-0011). M3.5
  fault-injection hardening is open.

---

## 4. Quickstart and deploy lineage

Full quickstart lives in [README.md](../README.md) — local dev is four commands
(`git submodule update --init --recursive`, `pnpm install`, copy `.dev.vars`,
`pnpm db:migrate:local` + `pnpm dev`), deploy is `pnpm setup:deploy` + secrets +
`pnpm build && pnpm deploy`, then verify with `pnpm smoke --base-url …`. A live
instance runs this path at <https://cf-gitea.hecongw.workers.dev>.

Production deployment lineage (all evidence in `docs/design/p0-evidence.md`):

| Version | When | Tree | What it carried |
|---|---|---|---|
| `cf93d51f-8361-…` | 2026-10-25 ~04:15 CST | P0 close-out | migrations 0005–0010 applied; P0 shallow probes 3/3 green against production; post-deploy smoke surfaced two findings (settle-window race, ACL row #2 gap) — both later resolved in production (`961ea22`, `562f257`) |
| `15802991-5bde-…` | 2026-10-25 09:28 CST | `bde4cb1` (`4a35091`) | migrations 0011–0013 (43 tables); vitest 1854/1854; smoke 5/0/2 — anonymous × private fetch answers 401 Basic challenge (ACL row #2 closed in production); P0 probes unchanged |
| `c68af947-cc6b-…` | 2026-10-25 14:59 CST | `a2ecd92`, the dispatch-freeze (`af9b1b5`) | everything the five landing waves shipped: UI waves 4–8, webhook 18/26, org teams + ACL, attachments, emails/keys/GPG (migration 0016), fork-dispatch fix, engine M3.0–M3.4; migrations 0014–0017 (48 tables); 784-asset rebuild; tsc 0 errors; vitest 2153/5 first fully green; smoke 6/0/1; P0 probes unchanged; first production bench |

[durable-git]: https://github.com/littledivy/durable-git

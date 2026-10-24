# ADR-0001: Technical Direction

Status: proposed · Date: 2026-10-24 · Supersedes the Phase-1-Artifacts lean in
`docs/research/tech-route-survey.md` (reversed after workload analysis, see below).

## Context

cf-gitea = Gitea-compatible forge backend on Cloudflare Workers (Hono + TypeScript +
Drizzle + D1 + DO + R2). 10 reference repos surveyed (`docs/research/tech-route-survey.md`).
Two decisions dominate everything else: the git storage engine, and what "Gitea as
frontend" concretely means.

Measured facts driving the decisions:

- Gitea web surface: ~789 route registrations in `routers/web/web.go`, 594 Go
  `html/template` files; the UI is server-rendered Go (Fomantic-UI/jQuery + Vue 3
  islands) and does NOT call `/api/v1`. Public API surface: 350 swagger paths.
- No standalone API-driven Gitea frontend exists upstream; the community has wanted
  one since 2019 (go-gitea/gitea#8174, Codeberg community#288 proposes exactly a
  frontend talking to Gitea exclusively via the API).
- Cloudflare Artifacts Beta: 1 GB/repo for repos created after 2026-09-29 (tightened
  from 10 GB), no ref-enumeration API, no local emulator, per-op billing, clones
  measured 4x larger than GitHub's (g1t). The Gitea API is object-read-heavy
  (contents/raw/trees/commits with diffs) — Artifacts per-op reads plus missing
  ref enumeration sit directly on the hot path.
- durable-git (MIT, npm, production-run): full smart-HTTP git server on DO+R2 with
  streaming ingest, delta resolution, GC; runs fully local in workerd.
- Cloudflare Containers: ephemeral disk only (no persistent volumes); real-git
  containers need an R2 snapshot/restore loop — viable as a cache, not as origin.

## Decisions

### D1 — Git engine: self-hosted, vendored `durable-git` as the base

Own the git engine on DO+R2. Vendor durable-git into the monorepo (MIT; we carry
patches) and evolve it toward git-on-cloudflare's streaming-receive patterns
(receive lease → stream pack to R2 → two-pass index → atomic ref+catalog commit
inside the DO). R2 is the blob source of truth; the per-repo DO (SQLite) holds refs,
pack catalog, leases; compaction via DO alarm + Queue.

Why not Artifacts as the foundation (reverses the survey's Phase-1 lean): the Gitea
workload (frequent object reads, branch/tag enumeration on every listing, diffs)
collides with Artifacts' missing ref API, per-op billing, 2000 req/10s per-repo
limit, and the tightening 1 GB cap; the workaround surface (ref tracking from push
events, in-memory emulator fake, R2 clone cache, op metering) costs more than the
~4k lines of pack code durable-git already ships and tests. Artifacts stays an
optional adapter (import/fork source) behind the storage interface — nothing more.

Why not WASM (gitoxide subset): no server plumbing exists upstream; the protocol
layer must be hand-written TS either way. Revisit only if pack performance becomes a
proven bottleneck. Why not Container-real-git as origin: ephemeral disk + snapshot
restore loop; only acceptable as a read cache (g1t's usage), and we don't need one
if we own the packs.

### D2 — "Gitea-compatible" is tiered; the product contract is Tier 1

- Tier 1 (the product): git smart HTTP at `/{owner}/{repo}(.git)?/*` + the 350-path
  `/api/v1` REST surface (contract = the vendored `v1-swagger.generated.json`) +
  Gitea token auth semantics (`Authorization: token …`, token-as-Basic-password,
  scoped tokens). This makes cf-gitea a headless Gitea.
- Tier 2 (the UI strategy): serve pages that reuse Gitea's built assets
  (web_src bundles) with our own server-rendered HTML
  (Hono JSX producing structurally compatible DOM), route-by-route, SPEC-gated.
  **Correction 2026-10-24 (ui-tier2 spike):** at the pinned commit the frontend
  builds standalone with Vite 8 (no Go, no webpack) and Fomantic-UI's CSS is
  deleted upstream — only a vendored 2-file Fomantic JS fork and jQuery 4 remain.
  See `docs/ui-tier2-plan.md`; core-page asset cost ≈ 969 kB.
- Tier 3 (never): byte-compatible reimplementation of the 789 web routes incl. Go
  templates, form flows, CSRF/flash semantics.

Rationale: Tier 1 is what every real client (CLI tools, release tooling, CI,
Gitea-API SDKs, the community's long-wanted standalone frontend) consumes; Tier 3
is re-implementing Gitea's Go server with no strategic payoff. Positioning: cf-gitea
becomes the headless-Gitea-on-Cloudflare that issue #8174 / Codeberg #288 have been
asking for.

### D3 — Architecture allocation

- D1 (Drizzle): users/orgs/teams, repository registry (immutable `storage_key =
  r_<id>` that never changes on rename; `visibility`; `refs_version` bumped every
  push as cache buster; `backend` field for future per-repo adapter routing),
  issues/PRs/releases/comments, tokens (SHA-256 digest + unique prefix), audit log.
- DO per repo (SQLite): refs source of truth, pack catalog, receive lease, compaction
  state, alarms for GC/idle cleanup. Tagged-union RPC results; never `blockConcurrencyWhile`
  in RPC; no Worker→DO→R2 transitive streaming.
- R2: packs (write-through during receive), LFS objects later (checksum-bound
  presigned PUTs), snapshots if a container read-cache is ever added.
- Worker (Hono): thin routes; `/api/v1` routers declared with `@hono/zod-openapi`
  and CI-checked against the vendored swagger (flare-forge discipline: a route
  without a spec entry fails CI; responses diffed against the contract).
- Streaming everywhere; `limits.cpu_ms: 300000`; pako (chunkSize 16 KB) for
  byte-accounted inflate; ≤100 bound params per DO SQLite statement; typed arrays
  for hot loops; secrets via wrangler only.

### D4 — Testing

- Unit/worker tests in `@cloudflare/vitest-pool-workers` against real local D1/DO.
- Black-box git e2e (clone/push/fsck/force/shallow/thin) — adopt durable-git's
  `scripts/e2e.sh` checklist as CI stage.
- API conformance: a runner that exercises `/api/v1` endpoints and validates against
  the swagger contract; optional oracle mode diffing against a real Gitea instance.
- Fuzz pkt-line and pack parsing from day 1 (untrusted input).

### D5 — Target Gitea version: pin explicitly

The submodule currently sits on `v29.0.0-dev-208-gfc49368845` — a recent 2026 dev
snapshot (350 swagger paths measured at this pin), not an old release. Prefer moving to
the newest stable tag at SPEC-0004 time and freeze that tag's swagger as the
compatibility contract. API drift is handled by re-pinning + contract regeneration,
not by chasing main. Upstream auth semantics verified at this pin: PBKDF2 token hashing,
9 scope categories (no sudo scope — admin sudo is a header), `token`/`Bearer`/Basic
header forms.

## SPEC order

1. `specs/0001-storage-engine.md` — vendored engine, DO/R2 layout, leases, ref CAS,
   e2e harness.
2. `specs/0002-auth.md` — Gitea token semantics, scopes, users in D1.
3. `specs/0003-repo-lifecycle-git-http.md` — create-by-push, clone/fetch/push routes,
   ACL matrix (401 vs 403 vs 404).
4. `specs/0004-api-v1-core.md` — repos/branches/tags/commits/contents/git endpoints
   (the ~80 paths covering most client usage), pagination + error formats per swagger.
5. `specs/0005-issues-prs-webhooks.md`.
6. `specs/0006-ui-tier2.md` — asset reuse strategy; plus LFS.

Later / out of scope initially: Gitea Actions compat (gitorange's container model is
the reference), repo mirrors, OAuth provider endpoints, email notifications.

## Annex — Performance & cost model (2026-10 prices, to be validated by SPEC-0001 benchmarks)

Unit prices: Workers Paid $5/mo (10M req + 30M CPU-ms incl; +$0.30/M req, +$0.02/M CPU-ms,
5-min CPU max); DO $12.50/M GB-s (≈400k GB-s incl), SQLite storage $0.20/GB-mo, row writes
$1/M; R2 $0.015/GB-mo (10 GB incl), Class A $4.50/M, Class B $0.36/M, zero egress; D1 row
reads $0.001/M, row writes $1/M; Artifacts $0.15/1k ops past 10k/mo, $0.50/GB-mo.

Modeled all-in cost: hobby forge (50 repos / 2 GB / 2k git ops / 0.5M API req per month)
≈ $5–6/mo (the $5 base dominates). Team forge (500 repos / 50 GB / 20k git ops / 5M API)
≈ $10–15/mo. The Artifacts route at the team workload is 1–2 orders more expensive
(read-heavy API ≈ $150/million object reads + 33x storage price + 2000 req/10s per-repo
wall); a warm real-git Container ≈ $35–60/mo with cold-restore latency; a 2C4G VPS pays
for egress alone (300 GB/mo of clone traffic exceeds typical caps).

Performance targets for SPEC-0001 (baselines to record in CI): clone throughput
client-bandwidth-bound via R2 fast path (reference: Artifacts measured 4x larger packs
at ~3.5 MB/s; GitHub ~11 MB/s for same repo — we store client-deltified packs verbatim);
push indexing ≈ seconds per 50 MB pack within 300s CPU ceiling, product quota ~1 GB/push;
repeat clones of the same commit served from edge Cache / R2 clone-pack cache
(refs_version-keyed, g1t pattern). Benchmark regression is a required CI stage from
SPEC-0001 onward: track clone MB/s, push wall/CPU time per 50 MB and 500 MB fixtures,
API p95, and peak memory; reference-repo numbers (g1t, durable-git, cloudflare-agent-git
spike) are leads to re-verify ourselves, not accepted baselines. Known watch-items: subrequest budget (index scan must
stream one R2 GET body, not many ranged reads), DO row-write cost on monorepo imports
(≈ $1/M objects), SSH protocol not possible on Workers (HTTPS git only; Spectrum or a
container would be needed if SSH is ever required).

## Rejected alternatives (summary)

| Alternative | Why rejected |
|---|---|
| Artifacts Beta as foundation | 1 GB cap tightening, no ref API, per-op cost on hot path, no emulator, beta risk |
| WASM gitoxide engine | No server plumbing upstream; protocol layer is TS either way |
| Container real-git as origin | Ephemeral disk forces snapshot loop; fine as cache only |
| Reimplement Gitea web routes (Tier 3) | ~789 routes + 594 Go templates + template engine; 2-3x the API surface, no strategic payoff |
| Write pack code from scratch | durable-git already ships and e2e-tests it (MIT); vendor, don't rewrite |

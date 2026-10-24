# Technical Route Survey: Git Hosting on Cloudflare

Survey of 10 reference repos cloned to `../cf-gitea-ref` (2026-10-24), researched to choose the
technical route for cf-gitea (Gitea-API-compatible backend on Workers: Hono + TypeScript +
Drizzle ORM + D1 + DO + R2, optional Cloudflare Artifacts Beta).

## Repos at a glance

| Repo | Stack | Role in this survey |
|---|---|---|
| zllovesuki/git-on-cloudflare | TS, Hono, D1+DO+R2, hand-written git | Production-grade reference for owning the git engine in TS |
| littledivy/durable-git | TS, DO+R2, hand-written git (npm lib, MIT) | The "own the engine" route, packaged as a library |
| mdhruvil/gitflare | TS, isomorphic-git over DO-SQLite FS | Cautionary tale; abandoned in favor of Artifacts |
| choyiny/gitorange | TS, Hono+zod-openapi, Drizzle/D1, better-auth, **Artifacts** | Closest match to our exact stack; the Artifacts-route product reference |
| flagon-io/g1t | Rust→WASM workers + **Artifacts** + Containers | Production forge on Workers; Artifacts at scale + mitigations |
| everyai-com/flare-forge | TS monorepo, **Artifacts** + DO + Workflows + Queues | Artifacts eventing/metering/ops-ledger discipline |
| alexeygrigorev/cloudflare-agent-git | TS, DO + **Artifacts** | The only systematic Artifacts Beta spike (artifacts-spike/RESULTS.md) |
| enroute-sh/enroute | Rust server (not CF) | Design textbook: ref transactions, layer storage, push pipeline |
| gitoxidelabs/gitoxide | Rust lib | WASM feasibility of an embedded git engine |
| hdresearch/ziggit | Zig (AI-generated) | Proof the protocol glue is small; delta-ingest is the correctness trap |

## Route A — Cloudflare Artifacts Beta as the git engine

Worker never parses packfiles. Pattern (gitorange `worker/src/git-http.ts`, g1t
`services/repos/src/git_http.rs`): authenticate → look up repo → mint a short-TTL repo-scoped
Artifacts token (`repo().createToken(scope, ttl)`) → proxy the smart-HTTP request through with the
Bearer token injected. UI reads go through the binding (`readCommit/readTree/readBlob/readFile/log/fork`).
Server-side writes (merges, commit-files) need only a small custom object codec + undeltified pack
push (gitorange `worker/src/git/{objects,bytes}.rs` analog: `CompressionStream('deflate')`, no pako).

Measured Artifacts Beta realities (cloudflare-agent-git `artifacts-spike/RESULTS.md`, g1t docs):

- No ref-enumeration API (binding or REST). Head = `log({ref, limit: 1})`; full refs only via
  `git ls-remote`; otherwise track refs from push events.
- Token format is `art_v2_x_<40hex>?expires=<unix>` — the documented `art_v1_` format is wrong.
  Never prefix-validate.
- `status` (`ready|importing|forking`) is only on the repo LIST call; `last_push_at` stays null
  forever; read-scope push fails with HTTP 400 (not 401/403).
- Fork is default-branch-only and its response embeds a live 24h write token — persist digests only.
- Limits: 1 GB/repo (repos created on or after 2026-09-29; repos created before that date are
  grandfathered at 10 GB — the direction is tightening, see
  developers.cloudflare.com/artifacts/platform/limits), 32 MB/blob, 1 TB/account (raisable),
  2000 req/10s per namespace and per repo. The per-repo cap cannot be split across Artifacts
  repos (git's object graph is per-repo and Artifacts offers no merged view, no server-side
  filters); overflow must go to LFS-on-R2 or a self-hosted backend behind the same interface —
  g1t ships exactly that escape hatch (`deploy/self-host/gitstore/server.mjs`: an
  Artifacts-compatible facade over bare git + `git http-backend`).
- No local emulator: dev/tests talk to the real remote service (gitorange uses an in-memory fake
  for tests) — Workers Paid only, open beta.
- Pack quality is poor: g1t measured the same repo cloning 134 MB/38 s from Artifacts vs
  34 MB/3 s from GitHub. g1t mitigates with an R2 whole-clone-pack cache teed off the stream
  (`pack_cache.rs`) and optionally a "git edge" Cloudflare Container running real `git http-backend`
  over a repacked mirror (`crates/runner/src/gitedge.rs`).
- Pricing: $0.15/1k ops past 10k/month, $0.50/GB-month past 1 GB. flare-forge measured
  11.2 ops/landed change when event-driven vs 40–130k ops when agents poll.
- Eventing: repo-level `pushed/cloned/fetched` work as wrangler triggers; account-level events do
  NOT fire through namespace-filtered triggers (flare-forge uses a REST subscription → Queue).
  Events are at-least-once; dedupe on `(repo, after)`, keep a reconciliation poll.

## Route B — Own the git engine in TypeScript (R2 packs + DO metadata)

Reference implementations: git-on-cloudflare (production, most complete) and durable-git
(MIT npm library; `createDurableGit()` is nearly drop-in).

Load-bearing techniques:

- Streaming push: DO-issued receive lease (concurrent push → 503 Retry-After) → parse only the
  pkt-line command section, stream the remaining body straight into R2 (multipart 8–16 MiB parts,
  `FixedLengthStream` when Content-Length known) → pass 1 scan (chunked reads, per-entry CRC-32)
  → pass 2 delta resolution (REF_DELTA bases may live in other packs) → byte-exact `.idx` v2 →
  atomic ref+catalog commit inside the DO (`transactionSync` / tagged-union RPC results).
- Do not advertise `thin-pack` on upload-pack (git-on-cloudflare): clients then send self-contained
  packs and the server never resolves client-side deltas. durable-git instead accepts thin packs
  and resolves bases cross-pack to a fixpoint.
- Emit stored OFS_DELTAs as REF_DELTAs when serving (durable-git): index-pack resolves ref-deltas
  in a second pass by oid, which decouples emission order from pack order and enables
  storage-order streaming + byte-identical R2 clone caches.
- Use pako (`Inflate`, chunkSize 16 KB), not `DecompressionStream`: pack entries are concatenated
  zlib streams and the indexer needs exact compressed-byte accounting for CRC-32/span boundaries.
- Verify the pack trailer SHA-1 before completing the R2 upload (sliding 20-byte window into a
  `DigestStream`).
- workerd limits to design around: ~100 bound variables per DO SQLite statement, 10 GB per DO
  (offload big packs to R2, keep only the index in SQLite), 128 MB isolate (typed arrays over
  object arrays; custom OidSet), `limits.cpu_ms: 300000`, DO soft ~1k req/s.

Cost: ~4k lines of subtle protocol code (negotiation, deltas, GC/compaction, shallow, thin packs)
plus queue-driven maintenance. gitflare is the documented failure mode of the naive version
(`docs/streaming-push.md` "Why This Exists" in git-on-cloudflare describes it exactly): buffered
receive + object-by-object traversal + no R2 → CPU/memory blowups. gitflare's final commit points
users at Cloudflare Artifacts instead.

## Route C — WASM-embedded git engine

gitoxide: `gix-pack/gix-object/gix-hash/gix-traverse/gix-zlib` have first-class wasm32 CI support
(`sha1,wasm` features; mmap avoided via `FileData`/`from_data()` generics; zlib-rs is pure Rust).
But `gix-protocol` cannot compile for wasm (hard dependency on `gix_ref::file::Store` in
`fetch/types.rs`), and gitoxide has **no server-side plumbing at all** (upload-pack/receive-pack
unchecked in `crate-status.md`). So WASM buys only the pack/delta/idx layer.

ziggit (AI-generated Zig git): implements the full smart-HTTP endpoint surface in ~1.1 KLOC of
buffer-in/buffer-out functions — proof the protocol glue is small. But its WASM `ingestPack`
silently skips OFS/REF_DELTA entries: any real git push (delta-compressed by default) would drop
objects silently. Delta ingest is the correctness trap. (GPL-2.0 — never copy its code.)

Verdict: protocol layer must be hand-written TS regardless; WASM only defers part of the pack
layer. Not worth the toolchain unless pack performance becomes a proven bottleneck.

## Design patterns worth adopting (all routes)

- Immutable storage identity: `repositories.artifacts_name = r_<id>` — renames/transfers never
  touch the backing store (gitorange).
- `refs_version` counter in D1 bumped on every push; used as a global cache-buster for ref
  listings (g1t).
- Ref transactions as CAS: gitoxide `PreviousValue` enum (`MustExist/MustNotExist/MustExistAndMatch`)
  maps onto D1 conditional updates executed inside the DO's atomic section (enroute/git-on-cloudflare
  converge on the same shape: async validation, then atomic multi-ref CAS commit; "fetch first"
  rejection on CAS failure).
- Push bookkeeping via refs-before/after diff in `waitUntil` when the git backend gives you no
  hook (gitorange), or via dedup'd push events (flare-forge, g1t).
- LFS via pre-signed R2 PUT with the checksum bound into the signature
  (`x-amz-checksum-sha256 = oid`), D1 stores bare keys only (gitorange).
- D1 gotchas: `ON DELETE CASCADE` inert without `PRAGMA foreign_keys`; LIKE/GLOB patterns capped
  at 50 bytes → use `instr()` or prefix-range indexes; D1 Sessions bookmark forwarding for
  read-your-writes (git-on-cloudflare `withSession`, g1t `crates/kit/src/d1.rs`).
- Never fetch worker→workers.dev (edge error 1042); use Queues or service bindings.
- Meter every storage op from day one; two sources reconciled with `max()`, never summed
  (flare-forge `forge-ops.ts`).
- Security: plaintext tokens shown once, SHA-256 digests at rest with prefix-indexed lookup;
  short-TTL scoped tokens minted per operation; agents never hold trunk write tokens
  (flare-forge asserts this in tests); 404-not-403 for invisible repos.
- Protocol details: receive-pack stays v0/v1 (v2 push doesn't exist); advertise `no-thin` to keep
  push validation store-free (g1t); zero-id + `capabilities^{}` pseudo-ref for empty repos;
  `Wants` must be currently-advertised oids (prevents leaking force-pushed secrets — durable-git);
  strict hex pkt-line length parsing (`parseInt` is an attack vector).

## Gitea API compatibility

None of the 10 repos implements the Gitea (or GitHub) REST API — this layer is greenfield and is
cf-gitea's actual differentiation. Nearest building blocks: gitorange's D1 schema
(users/repos/collaborators/PRs/releases/agents) and `@hono/zod-openapi` route discipline;
flare-forge's CI-enforced OpenAPI coverage check (routes must have spec entries — the same
discipline against `gitea/templates/swagger/v1-swagger.generated.json`); gitorange's merge/land
via CAS fast-forward; g1t's hidden-refs (`refs/pull/*`) push-command rewriting.

## Recommendation for cf-gitea

1. **Phase 1 — Artifacts Beta as the git engine** behind the storage interface already mandated
   in AGENTS.md (gitorange pattern: authenticating proxy + binding reads + refs_version cache
   invalidation + push-event bookkeeping). Spend the saved effort on the Gitea API surface,
   which is the actual product gap. Accept: beta dependency, Workers Paid, no emulator
   (in-memory fake for tests), 1 GB/repo, clone bandwidth mitigated later by an R2 pack cache.
2. **Phase 2 (contingency) — swap the storage adapter** to a self-hosted engine if Artifacts
   limits bite: adopt `durable-git` (MIT, npm) or port git-on-cloudflare's receive pipeline.
   The AGENTS.md storage-service boundary exists precisely for this swap.
3. Testing: `@cloudflare/vitest-pool-workers` against real local D1 + an in-memory Artifacts fake
   (gitorange's shape), plus a black-box git e2e suite (clone/push/fsck/shallow/thin — reuse
   durable-git's `scripts/e2e.sh` checklist) against a staging namespace.
4. Read before writing the storage SPEC: git-on-cloudflare `docs/streaming-push.md` (why
   buffering kills Workers), g1t `apps/docs/.../architecture/git.mdx` (Artifacts push path),
   cloudflare-agent-git `artifacts-spike/RESULTS.md` (API ground truth).

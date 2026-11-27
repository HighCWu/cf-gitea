# SPEC-0024: Large-Repository Split-Plane Git Engine (Worker Streaming Upload-Pack, Queue Compaction, Ref-Index Sidecars, and Bundle-URI)

Status: accepted — M4.0 implemented & locally verified (2026-11-27) · Date: 2026-11-27 · Amends: SPEC-0001, SPEC-0001a, SPEC-0011
Depends on: SPEC-0001, SPEC-0001a, SPEC-0003, SPEC-0011
Governs: `packages/git-engine/`, `apps/worker/src/git-http/`, `apps/worker/src/queues/`
Reference implementations studied: `/home/whc/pnpm_repos/cf-gitea-ref/git-on-cloudflare`, `/home/whc/pnpm_repos/cf-gitea-ref/enroute`, upstream `gitea/routers/web/repo/githttp.go`
Operator mandate: Keep Cloudflare cost-efficiency (minimize R2 Class A/B operations and DO GB-s) and strict Git protocol compatibility (v0/v2, sideband/plain, stock git clients).

---

## 1. Problem statement & root-cause diagnosis

Live mirror acceptance against `git.aiapp.run` on `comfyui-frontend` (**1.577 GB**, **11,410 commits**, pushed across **49 segmented waves**) demonstrated that anonymous `git clone` fails **5 out of 5 attempts** (3 mid-stream `curl 56` resets and 2 `HTTP 500` / `fatal: expected 'packfile'` failures), even though object completeness on the server is verified green (`git bundle` round-trip passes `fsck exit=0`, `6741` first-parent commits, `11410` total commits, exact tree OID match).

While `SPEC 0230` (commit `07e8707`) fixed `receivePack` answer-silence timeouts by streaming `report-status` and emitting `0005\x01` keepalives, four structural bottlenecks remain in `packages/git-engine/`:

1. **Synchronous pre-header DO walk & un-heartbeated `uploadPack` (`HTTP 500` / `expected 'packfile'`)**
   - In `packages/git-engine/src/mod.ts:2293-2310` and `src/repo.ts:769`, any `serveCloneFromR2()` miss forwards `POST /git-upload-pack` into the `RepoCell` Durable Object.
   - Before returning the HTTP `Response` (before sending `packfile\n` or `NAK\n`), `uploadPack()` (`packages/git-engine/src/git/protocol.ts:1082-1230`) synchronously executes `collectPackOids()` (walking commit/tree closure via R2 reads + `pako.Inflate`), `store.saveReachable()` (writing hundreds of thousands of OIDs into DO SQLite `reachable`), and `order.sort()` over five parallel typed arrays.
   - No `0005\x01` keepalive is emitted during this pre-header phase, hitting Cloudflare edge TTFB/silence caps or DO isolate CPU/128 MiB memory limits before a single wire byte leaves the origin.

2. **1 MiB Range-GET subrequest explosion on cold/multi-pack clones (`curl 56` mid-stream cutoffs)**
   - `PackStore` (`packages/git-engine/src/git/packstore.ts:10,425-427`) fetches R2 pack bytes in fixed **`PACK_CHUNK = 1 MiB`** Range GET slices with a 4-chunk LRU (`RAW_CHUNK_CACHE = 4`).
   - Streaming 1.577 GB (~1,615 MiB) sequentially through `readRaw()` consumes at least **1,615 R2 Range GET subrequests** inside a single DO invocation (more when cross-pack delta chains evict the 4 MiB LRU), plus ~100 R2 `MultipartCapture` subrequests (`R2_PART_SIZE = 16 MiB` in `src/git/multipart.ts:13`, driven inline at `src/git/protocol.ts:1250-1323`).
   - This mathematically exceeds Cloudflare's **1,000-subrequest per-invocation ceiling**, killing the stream mid-transfer; on abort, `capture.abort()` discards the partial `clone-cache` object, leaving the repo permanently stuck in the cold DO path.

3. **32 MiB DO-heap compaction lock (`compaction.ts:80-88`)**
   - `runCompaction()` (`packages/git-engine/src/compaction.ts:80-88`) runs inside `RepoCell` DO memory and is hard-capped at `COMPACTION_WINDOW_BYTES = 32 * 1024 * 1024` and `COMPACTION_WINDOW_OBJECTS = 50_000`.
   - Any pack larger than 32 MiB is skipped by `activeCatalogWindow`, permanently trapping 49-wave repositories in a fragmented multi-pack layout that magnifies fetch walks and thin-base hops.

4. **Push-plane write amplification & uncoalesced external delta reads**
   - `receivePack()` stages the incoming pack to R2 and then invokes `copyObject(bucket, begin.stagingKey, packKey)` (`src/mod.ts:1670`), reading and re-writing the entire pack a second time.
   - `DeltaResolver` (`src/receive/delta.ts:86`) issues one uncoalesced `readEntryBytes` R2 Range GET per missing external delta base with a hard `RANGE_BUDGET = 256` cap.
   - `putRows` (`src/git/packstore.ts:529-542`) replicates every received object into DO SQLite `pack_objects` (batches of `ROW_BATCH_ROWS = 8`), swelling DO SQLite storage and RPC overhead on large pushes, while `DEFAULT_MAX_PUSH_MB = 512` (`src/mod.ts:190`) forces multi-gigabyte imports to shard into dozens of push waves.

---

## 2. Gitea behavioral parity & hard invariants

Moving data-plane streaming out of `RepoCell` must preserve **100% behavioral parity** with upstream Gitea (`gitea/routers/web/repo/githttp.go`) and `cf-gitea`'s existing safety guarantees:

1. **Auth, visibility & repo-access matrix (`apps/worker/src/git-http/gate.ts`, `githttp.go:62-246`)**
   - Preserve exact HTTP Basic / PAT / OAuth2 realm (`Basic realm="Gitea"` vs `Basic realm="Gitea (Basic Auth)"`), `REQUIRE_SIGNIN_VIEW` strict gating, `ENABLE_BASIC_AUTHENTICATION`, mirror read-only rejection, archived repo rejection, and empty-repo `ls-refs=unborn` behavior.
   - All Worker-side R2 streaming fast paths and `bundle-uri` endpoints MUST run strictly downstream of `gate.ts` auth & permission resolution.

2. **Reachability & anti-leakage (`uploadpack.allowAnySHA1InWant=false`, `protocol.ts:124-150`)**
   - Unfiltered clones/fetches MUST only serve OIDs reachable from currently advertised tips (and peeled annotated tags); commits orphaned by force-push or branch deletion must remain unreachable unless an explicit object filter (`blob:none` / `blob:limit=n`) authorizes promisor object lookup.
   - Single-pack zero-copy passthrough MUST NOT run if a pack contains unreachable objects (e.g., force-push garbage prior to GC compaction), unless verified clean by `clean_reachable`.

3. **Protocol wire parity (v0 & v2)**
   - Keep existing advertised capabilities (`v2`: `ls-refs=unborn`, `fetch=shallow filter`; `v0`: `multi_ack_detailed`, `no-done`, `shallow`, `side-band-64k`, `symref=HEAD:...`), `deepen <n>` / `--unshallow`, and fail-closed `ERR upload-pack: unsupported fetch argument` handling for unimplemented options (`deepen-since`, `deepen-not`, `deepen-relative`).
   - Keep `pre-receive` (`validatePush`, AGit lane, protected branch checks, `atomic` transaction abort, `push-options`) and `post-receive` (`onPush`, webhooks, registry updates, `pushSettled` ordering) identical.

4. **SPEC-0011 Property A (safety over availability) & fail-stop leases**
   - Every completed fetch/clone must carry a valid pack (exact object count, intact delta bases, valid trailing SHA-1).
   - If a read lease expires or is rejected (because GC transitioned a `RETIRED` pack to `RECLAIMABLE`), the Worker MUST terminate the HTTP response stream with an error **before** emitting any trailing `FLUSH` (`0000`), never emitting a truncated or false-success tail.

5. **Vendored deviation tracking (`packages/git-engine/NOTICE.md`)**
   - Any behavioral or structural departure from the upstream `durable-git` baseline (`packages/git-engine/`) must remain documented in `packages/git-engine/NOTICE.md`.

---

## 3. Target split-plane architecture & reference synthesis

The refactored engine adopts a strict **control-plane / data-plane separation** matching `git-on-cloudflare` and `enroute`, adapted to `cf-gitea`'s existing `RepoCell` lease model and Hono/D1/Queue worker:

- **Control Plane (`RepoCell` DO)**: Authoritative refs, `HEAD`, `pack_catalog` four-state lifecycle (`active` / `retired` / `reclaimable` / `deleted`), `leases` (`receive` / `read` / `compaction`), ref CAS transactions, and lightweight read APIs. **Zero bulk pack bytes ever stream through the DO.**
- **Data Plane (`apps/worker` stateless fetch/push handlers + `packages/git-engine` Worker helpers)**: Performs Smart HTTP framing, `.idx` + `.pref` lookups in R2 (with Cache API), multi-pack streaming pack assembly (`OFS_DELTA`-preserving), and streaming direct-to-R2 push ingest.
- **Maintenance Plane (`REPO_TASKS` Queue Consumer)**: Executes asynchronous multi-pack compaction, orphaned R2 cleanup, `.pref` backfill, and optional Git Bundle generation without heap or DO wall-clock limits.

### Reference architecture comparison

| Problem | `durable-git` (current `cf-gitea` base) | `gitorange` / `gitflare` | Adopted from `git-on-cloudflare` & `enroute` |
|---|---|---|---|
| **Large clone I/O** | DO loops 1 MiB `R2.get` ranges (`1,615+` subrequests for 1.5 GB) | `gitorange` proxies Artifacts; `gitflare` still runs upload-pack inside DO | Worker executes `upload-pack` directly: **1 streaming `R2.get()` per source pack** (`passthroughSinglePack` takes **2 subrequests total** regardless of pack size) |
| **Cold graph walk** | DO walks commit/tree R2 objects + inflates via `pako` + writes DO SQLite `reachable` | Re-walks or buffers in memory | **`.pref` binary ref-index sidecars** generated once on push/compaction (`git-on-cloudflare` `refIndex.ts`); millisecond Worker closure without object decompression |
| **Multi-pack merge & GC** | DO heap `mergeWindow` capped at 32 MiB / 50k objects | `git-on-cloudflare` Queue streaming rewrite + `REPO_MAINT_QUEUE` | `REPO_TASKS` queue consumer streams source packs in topological `OFS_DELTA` order using R2 multipart (`64 MiB` parts); zero heap cap |
| **Delta encoding** | Rewrites all cross-object deltas as 20-byte `REF_DELTA` (`protocol.ts:1132`) | Same or inflates | `git-on-cloudflare` (`stream.ts`) & `enroute` (`read-path.md`): topological base-before-delta ordering emits compact 1–4 byte `OFS_DELTA` headers |
| **Multi-GB HTTP resets** | Single stateless POST stream | None | Standard Protocol v2 `bundle-uri` pointing to auth-signed Range-capable R2 bundles (`HEAD` + history catch-up via tiny fetch) |

---

## 4. Phased implementation plan (M4.0–M4.3)

### M4.0 (P0 — Unblock multi-GB `git clone` immediately)

Goal: Make bare anonymous 1.577 GB `git clone` pass 5/5 against an already-pushed multi-pack repo without requiring re-push.

1. **Extract `uploadPack` data plane from `RepoCell` DO into the Worker (`src/mod.ts`)**
   - Add a lightweight DO control-plane RPC `planWorkerFetch(repo, req)` that:
     - Validates `wants` against `advertisedOids` (`allowAnySHA1InWant=false`, or `store.has` for `filter`), computes `deepen`/`shallow` boundaries and `haves` exclusions, acquires a SPEC-0011 `read` lease over the active `pack_catalog`, and returns `{ lease, refsVersion, packs: PackCatalogRow[], wants, haves, commitLimit, filter }` (plus any loose-only OIDs).
     - Performs zero R2 chunk reads during planning whenever possible.
2. **Stream-first response + official `uploadpack.keepAlive` (`0005\x01`)**
   - Once request parsing and `wants` validation succeed, immediately open and return a `200 application/x-git-upload-pack-result` `ReadableStream`, enqueueing the `packfile\n` (v2) or `NAK\n` / `ACK` (v0) preamble first.
   - Drive an idle-gated `setInterval` heartbeat (mirroring SPEC-0230's `openReceiveStreamArm`, configurable via `GIT_UPLOAD_KEEPALIVE_MS`, default `20_000` ms, clamped `[50, 30_000]`) emitting `0005\x01` whenever planning/R2 opens stall without data/progress frames, eliminating `expected 'packfile'` edge timeouts.
3. **Replace 1 MiB Range-GET loops with 1 sequential streaming `R2.get()` per source pack**
   - For each pack in `plan.packs`, the Worker opens **one** streaming `env.REPO_PACKS.get(packR2Key)` (or at most a small number of contiguous range streams bounded far below 1,000 total subrequests), advancing forward over `(offset, dataOff, dataLen)` and discarding unselected gaps in the stream.
   - Renew the DO read lease inline at pack boundaries and every ~32 MiB of streamed bytes (`renewAndAuthorizeRead`), failing the stream (no `FLUSH`) on lease rejection, and releasing the lease on last R2 read / cancel (`SPEC-0011 §3.4`).
   - Fast path (`passthroughSinglePack`): When `fullClone === true`, `plan.packs.length === 1`, no loose objects exist, and `plan.packs[0].cleanReachable === 1`, stream the single R2 pack object verbatim (stripping and re-digesting or verifying its 20-byte trailer) wrapped in `side-band-64k` frames (**2 subrequests total**).
4. **Remove synchronous inline `MultipartCapture` tee from live clones**
   - Delete `clone-cache/` multipart capture inside live `uploadPack()` (`protocol.ts:1249-1345`). Live clones never spend 100+ extra subrequests or 16 MiB part buffers writing `clone-cache` mid-download; single-pack compaction in M4.1 replaces `clone-cache` cleanly.

### M4.1 (P1 — Queue-driven streaming compaction + `.pref` ref-index sidecar)

Goal: Collapse 49 fragmented packs into one clean pack and replace DO commit/tree walks with O(1)-inflate closure planning.

1. **Migrate compaction from `RepoCell` DO to `REPO_TASKS` Queue (`apps/worker/src/queues/`)**
   - Keep SPEC-0011's four-state lifecycle (`active` → `retired` → `reclaimable` → `deleted`) and lease exclusion rules (`hasActiveLease('receive')`).
   - Replace DO `runCompaction()` heap merge with three thin DO RPCs: `beginQueueCompaction()`, `commitQueueCompaction()`, `abortQueueCompaction()`, plus `scheduleCompaction` via `REPO_TASKS.send({ kind: 'pack-compact', repo, doId })` from `finalizeReceive` / `POST /compact`.
   - Remove the 32 MiB / 50k object cap: the Queue consumer selects eligible active packs, reads each pack via 1 sequential streaming `R2.get()`, deduplicates reachable OIDs (reclaiming force-push orphans and setting `clean_reachable = 1` when compacting the full active tip closure), sorts topologically so bases precede deltas (emitting compact `OFS_DELTA` headers), writes `.pack` + `.idx` + `.pref` to R2 using `64 MiB` multipart parts (up to ~160 GiB per pack within isolate memory bounds), and calls `commitQueueCompaction()` in one DO SQLite transaction.
2. **Add `.pref` (Pack Ref Index) sidecar files (`repos/<storage_key>/packs/<packName>.pref`)**
   - Compact binary format (modeled on `git-on-cloudflare/src/worker/git/pack/refIndex.ts`: `PREF` header, type codes aligned to `.idx` OID order, CSR `refStarts` uint32 array, flat 20-byte `rawRefs` buffer of parent/tree/child OIDs).
   - Generated during `receivePack`'s `walkPack` pass (where commit/tree/tag objects are already inflated once) and during Queue compaction; lazy `pack-ref-backfill` queue job populates `.pref` for pre-M4.1 packs.
   - Worker fetch planning (`excludedObjects` / `collectPackOids` / `computeDepthSet`) loads `.pref` via `R2.get()` + Workers Cache API (zero pack object inflation, zero DO SQLite `reachable` writes, bounded memory).

### M4.2 (P2 — Large push hardening & DO SQLite slimming)

Goal: Enable reliable multi-hundred-MB to multi-GB pushes without 49-wave manual sharding.

1. **Eliminate `copyObject(stagingKey → packKey)` double R2 I/O (`src/mod.ts:1670`)**
   - Generate a unique final pack identity (`packs/rx-<leaseToken>.pack` or content-hash name once staged if multipart rename is unavailable—use lease-scoped `packs/rx-<leaseToken>.pack` + `.idx` + `.pref`) and stream incoming push bytes **directly** to the final R2 pack location with **64 MiB** multipart parts (`R2_PART_SIZE` raised from 16 MiB to 64 MiB on push ingest).
   - Because `pack_catalog` remains unmodified until `finalizeReceive`, unfinalized pushes stay invisible to readers and `releaseReceive(..., { sweep: true })` / lease-expiry GC deletes orphaned `packs/rx-<leaseToken>.*` objects.
2. **Coalesced R2 Range GETs for thin-pack external delta bases (`src/receive/delta.ts`)**
   - Group external delta bases discovered in `DeltaResolver.finish()` by `packKey`, sort by `dataOff`, and merge contiguous or near-contiguous ranges (gap `<= 256 KiB`, merged window `<= 4 MiB`) before issuing `bucket.get(key, { range })`.
   - Raises effective coverage of `RANGE_BUDGET` by 10–50× on segmented thin pushes while bounding isolate memory to 4 MiB per window.
3. **Shift hot object lookups from DO SQLite `pack_objects` to R2 `.idx` v2**
   - Phase out per-object `putIndexRows()` SQLite replication (`packstore.ts:529-542`) on the receive path in favor of binary-searching cached R2 `.idx` v2 fanout/OID tables (matching `git-on-cloudflare`).
   - Raise configurable `DEFAULT_MAX_PUSH_MB` ceiling (default e.g. `2048` MiB via wrangler var `MAX_PUSH_MB`), removing the artificial 512 MiB push wall while keeping `MAX_UPLOAD_PACK_BYTES` bounded for negotiation bodies.

### M4.3 (P3 — Standard Git Protocol v2 `bundle-uri` for resumable multi-GB clones)

Goal: Give modern Git clients HTTP Range resumability and CDN/R2 edge speeds on multi-GB repos without long-lived Worker streams.

1. **Bundle materialization on compaction**
   - After Queue compaction produces a clean consolidated pack (> configurable threshold, e.g. `> 64 MiB`), optionally generate a Git Bundle v2 (`# v2 git bundle\n`, advertised refs + pack bytes) at `repos/<storage_key>/bundles/<refsVersion>.bundle` in R2.
2. **Protocol v2 `bundle-uri` advertisement & auth-gated signed URLs**
   - Advertise `bundle-uri` in `advertisement(..., v2 = true)` (`protocol.ts:69`) when enabled and a ready bundle exists.
   - Implement `command=bundle-uri` in `uploadPack()`: after `gate.ts` verifies read auth (public anonymous or private PAT/OAuth), mint an HMAC-SHA256 time-bounded signed token (`BUNDLE_SIGNING_SECRET`, TTL 15 min) for `GET /<owner>/<repo>.git/bundle/<id>` backed directly by R2 with full `Range` / `206 Partial Content` / `Accept-Ranges: bytes` support.
   - Clients without `transfer.bundleURI` transparently use M4.0/M4.1 Worker streaming; clients with `bundleURI` download the base history over resumable Range requests and fetch only post-bundle delta commits from `upload-pack`.

---

## 5. Quantitative budgets, schema changes & lease safety

### Budget comparison on the `1.577 GB / 11,410-commit / 49-pack` benchmark

| Metric | Current (`HEAD 4e31e9c`) | After M4.0 (P0) | After M4.1 + M4.2 (P1+P2) | After M4.3 (P3) |
|---|---|---|---|---|
| **Worker/DO subrequests per full clone** | **1,715+** (1,615× 1 MiB DO Range GETs + ~100 multipart parts) → **HARD FAIL (>1,000)** | **≤ 55** (1 RPC + ≤49 whole-pack R2 streams + lease renewals) | **2–4** (`passthroughSinglePack`: 1 RPC + 1 R2 stream + release) | **1** (`bundle-uri` GET via Range; 0–1 follow-up fetch) |
| **Time to first response byte** | **>60 s / timeout** (sync walk + SQLite write + sort before stream opens) | **< 200 ms** (stream opens immediately + `0005\x01` keepalive every 20 s) | **< 100 ms** (1 DO plan RPC + stream header) | **< 50 ms** |
| **Peak isolate heap during clone** | >128 MiB risk (5 typed arrays + inflated commits/trees + 16 MiB multipart buffer) | **≤ 16 MiB** (sequential stream copy, 0 multipart capture) | **≤ 8 MiB** (single-pack passthrough + bounded `.pref`) | **< 2 MiB** (R2 Range response passthrough) |
| **Max compactable pack size** | **32 MiB** (DO heap merge) | 32 MiB (DO compaction unchanged) | **Unlimited** (Queue streaming + 64 MiB R2 multipart up to 160 GiB) | Unlimited |
| **Push R2 I/O amplification** | **2×** write (`staging` → `copyObject` → `packs/`) | 2× write | **1×** write (direct to final R2 key, 64 MiB parts) | 1× write |

### Minimal additive DO SQLite schema changes (`src/git/migrations.ts`)

Zero D1 migrations are required. Extend DO SQLite `pack_catalog` additively:
- `clean_reachable INTEGER NOT NULL DEFAULT 0` (`1` iff the pack holds only reachable objects from an atomic compaction/root push, enabling `passthroughSinglePack`).
- `pref_bytes INTEGER NOT NULL DEFAULT 0` (byte length of the `.pref` sidecar in R2 when present).
- `tier INTEGER NOT NULL DEFAULT 0` (geometric compaction tier for multi-round scheduling).

### Read-lease safety across Worker-side streaming (`SPEC-0011 §3`)

- In M4.0/M4.1, `planWorkerFetch` inserts the `leases` row (`kind = 'read'`) atomically in the same DO SQLite transaction that snapshots active `pack_catalog` rows.
- Before opening each pack's `R2.get()` stream — and after every `32 MiB` read within an `R2.get()` stream if `Date.now() >= lease.expiresAt - READ_RENEW_MARGIN_MS` — the Worker calls `stub.renewAndAuthorizeRead(planId, packKey, null)`.
- A rejection (`expired` or `reclaimable`) throws inside the `ReadableStream` `pull`/pump loop, invoking `ctrl.error(err)` so the HTTP/2 stream resets/aborts cleanly **before** any `FLUSH` (`0000`) frame is written (Property A preserved).
- `stub.releaseReadLease(planId)` runs once the final R2 byte finishes reading (or in `cancel()` on client disconnect), keeping lease cleanup decoupled from slow-client downstream TCP drain.

---

## 6. Acceptance criteria & verification gates

1. **Unit & contract suite (`pnpm test`)**
   - `.pref` encoder/decoder round-trip parity against full commit/tree graph walk (`excludedObjects` + `collectPackOids` + `computeDepthSet` set equality).
   - `OFS_DELTA` distance encoder + streaming topological compaction produces packs verifiable by stock `git index-pack --strict` and `git fsck`.
   - Direct-write `receivePack` crash fault tests: abort before `finalizeReceive` leaves zero visible refs and expires/sweeps `packs/rx-*` R2 objects cleanly.

2. **SPEC-0011 fault-injection gate**
   - Inject GC `RETIRED → RECLAIMABLE` transition mid-Worker-stream: next lease renewal fails, Worker errors the `ReadableStream` with **no `FLUSH`** packet emitted, and `git clone` fails non-zero rather than silently accepting a truncated repo.
   - Inject compaction crash between R2 multipart upload and `commitQueueCompaction`: orphan R2 `.pack`/`.idx`/`.pref` cleaned up on lease expiry without harming active packs.

3. **Gitea & stock-`git` differential matrix**
   - Full differential parity across `v0` & `v2`: full clone, incremental `fetch`, `--depth=1` / `--deepen=N` / `--unshallow`, `--filter=blob:none`, `--filter=blob:limit=N`, `ls-refs=unborn`, `allowAnySHA1InWant=false` after force-push, `atomic` + `--push-option` + pre-receive hook rejection, private repo 401/403 enforcement, and `bundle-uri` fallback when disabled client-side.

4. **Black-box large-repo live acceptance gate**
   - **Clone gate**: Against a real pushed mirror of `comfyui-frontend` (**1.577 GB**, **11,410 commits**), run **5 consecutive anonymous `git clone`** invocations (with `bundleURI` off for M4.0/M4.1 and on for M4.3); **5/5** must exit `0`, pass `git fsck --full --strict`, and match exact commit counts (`6741` first-parent / `11410` all) and root tree hash.
   - **Compaction gate**: Trigger Queue compaction on the 49-pack repository; verify convergence to `<= 2` active packs within bounded Worker memory/CPU and non-blocking concurrent `info/refs` reads.
   - **Push gate**: Push a single `> 600 MiB` pack wave (with coalesced thin bases against an existing pack) and verify clean `unpack ok` + ref update + zero `copyObject` I/O.

---

## 7. Rollout, rollback & open decisions

### Rollout flags (strict-polarity vars in `apps/worker/wrangler.jsonc.example`)
- `UPLOAD_PACK_WORKER_STREAM`: `"true"` activates M4.0 Worker streaming `uploadPack` + `GIT_UPLOAD_KEEPALIVE_MS` (`"20000"`); default/unset retains legacy DO path for incremental verification.
- `COMPACTION_QUEUE_ENABLED`: `"true"` routes compaction triggers to `REPO_TASKS` consumer (`M4.1`).
- `RECEIVE_DIRECT_PACK_WRITE`: `"true"` enables direct-to-final-key push & coalesced delta Range reads (`M4.2`).
- `BUNDLE_URI_ENABLED`: `"true"` enables v2 `bundle-uri` advertisement and signed R2 bundle serving (`M4.3`, requires secret `BUNDLE_SIGNING_SECRET`).

### Rollback
- All DO SQLite schema additions (`clean_reachable`, `pref_bytes`, `tier`) and R2 `.pref`/`.bundle` sidecars are strictly additive; flipping the feature flags above back to `"false"` or performing a Cloudflare Worker version rollback restores prior behavior immediately without data loss. (Note: any already-compacted large pack remains valid and readable via M4.0's streaming reader.)

### Operator decisions (Accepted 2026-11-27)
- **D1 Accepted (`pack_objects` SQLite retirement scope in M4.2)**: Retire `pack_objects` from `receivePack`/`lookupObjects` first via a Worker `.idx` reader helper in M4.2a, then migrate UI RPCs in M4.2b so M4.0–M4.2a stays narrow.
- **D2 Accepted (`MAX_PUSH_MB` ceiling & R2 multipart part size)**: Use **64 MiB** R2 multipart parts (10,000 parts = 640 GiB theoretical ceiling) and raise default `MAX_PUSH_MB` from `512` to `2048` MiB (configurable via env).
- **D3 Accepted (`bundle-uri` transport endpoint in M4.3)**: Serve signed Range requests via `GET /<owner>/<repo>.git/bundle/<token>` backed by R2 (`R2.get(key, { range })` passthrough) with strict Gitea visibility checks.

### Implementation evidence
- **M4.0 (2026-11-27)** — Implemented Worker-side warm full-clone streaming (`packages/git-engine/src/upload/stream.ts`, `src/git/store.ts`, `src/git/protocol.ts`, `src/repo.ts`, `src/mod.ts`, `src/env.ts`, `apps/worker/wrangler.jsonc[.example]`, `packages/git-engine/NOTICE.md`) and integration suite (`apps/worker/src/git-http/upload-worker-stream.test.ts`):
  - `pnpm typecheck` — passed (exit `0`; regenerated `packages/git-engine/dist-types/` and `apps/worker/worker-configuration.d.ts`).
  - `pnpm --filter cf-gitea-worker exec tsc --noEmit && pnpm exec eslint apps/worker/src/git-http/upload-worker-stream.test.ts` — passed (exit `0`, 0 lint errors/warnings).
  - `packages/git-engine/e2e/check-drain-discipline.mjs` — all `4` checks passed (`121` exec sites: `118` SqlStorage with `69` SELECT drained / `49` DDL-DML, `3` RegExp excluded).
  - `packages/git-engine/e2e/check-cache-unreachable.mjs` — all checks passed (exit `0`).
  - `packages/git-engine/e2e/check-segmented-serve.mjs` — all `10` checks passed.
  - `packages/git-engine/e2e/check-capability-matrix.mjs` — all `22` checks passed.
  - `packages/git-engine/e2e/check-read-leases.mjs` — all `25` checks passed.
  - `pnpm --filter cf-gitea-worker exec vitest run src/git-http/upload-worker-stream.test.ts` — `5/5` passed (`worker-passthrough` single-pack v2/v0 sideband/v0 plain, multi-pack sequential `worker-stream`, G3 fail-closed/`deepen-since`/shallow/filter/have/force-push isolation, SPEC-0011 Property A mid-stream lease abort before `FLUSH`, and idle-gated `0005\x01` sideband keepalive vs zero keepalives on plain v0).
  - Related existing `vitest` suites (`src/git-http/gate.test.ts`, `src/git-http/receive-external-base-walk.test.ts`, `src/git-http/receive-stream-keepalive.test.ts`) ran with zero source edits afterwards — `126/126` passed.
  - Pending: M4.1 (Queue streaming compaction + `.pref` sidecar), M4.2 (direct `receivePack` final-key write + `pack_objects` retirement), M4.3 (`bundle-uri` serving), and remote staging/live clone acceptance.

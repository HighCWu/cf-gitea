# SPEC-0001: Git Storage Engine (self-hosted, R2 + Durable Objects)

Status: draft · Date: 2026-10-24 · Implements ADR-0001 decision D1.
References: `docs/decisions/0001-technical-direction.md`,
`docs/research/tech-route-survey.md`, upstream `durable-git` (MIT, vendored — see §8),
`git-on-cloudflare` receive pipeline (design reference, license to verify before copying).
Amended by `specs/0001a-split-plane-amendment.md` (M2 design-of-record: DO inventory,
exact RPC signatures, R2 key-site map, landing gates; §6/§7 of this SPEC defer to it
where they overlap).

## 1. Problem and scope

The git engine: everything between an authenticated HTTP git request and bytes in storage.
It owns the smart-HTTP protocol, packfile indexing, ref transactions, and maintenance.

In scope:

- Vendor durable-git and adapt it to a split-plane architecture (§2).
- R2 key layout, RepoDO SQLite schema, refs CAS, receive leases (§3–4).
- Receive path: streaming staging, quota gate, two-pass index, atomic finalize (§5).
- Serve path: v2 fetch negotiation, single-pack R2 fast path, refs edge cache (§5).
- Compaction (alarm-triggered, queue-executed) and orphan sweeps.
- Merge/fork/diff primitives (engine-resident typed RPCs: mergeBase, three-way
  tree merge, mergeability classification, executeMerge/rebaseOnto, range walks,
  CAS ref delete, fork catalog replication + PR relay) — per
  `specs/0001b-merge-fork-primitives.md`, the design-of-record for that surface.
- Fuzzing, e2e harness, benchmark CI regression stage (§6–7).

Out of scope (later SPECs): auth/ACL/token semantics (0002), git HTTP routes,
create-by-push, repo lifecycle, the async chunked import channel for >1 GiB histories
(0003), `/api/v1` (0004), LFS, UI, SSH (never — documented exclusion).

## 2. Architecture

- **Worker (edge, data plane)**: pkt-line parse, receive-pack body streaming into R2,
  pack scan + delta resolution, idx v2 emission, upload-pack serving (sideband mux,
  incremental SHA-1 via `crypto.subtle` / `DigestStream`). Pack bytes never pass through
  the DO.
- **RepoDO (control plane, SQLite-backed, one per repository)**: refs source of truth,
  `refs_version`, receive leases, pack catalog, compaction state, alarms (lease expiry,
  compaction re-arm, idle cleanup). `locationHint` pinned to the R2 bucket region.
- **Hard rules** (from ADR-0001 / goc invariants): no Worker→DO→R2 transitive streaming;
  DO RPC returns *application* outcomes as tagged unions
  (`committed | ref_conflict | lease_mismatch`), never as thrown errors — transport
  failures (network, DO eviction) still surface as RPC exceptions and the caller treats
  them as retryable-unknown (finalize is idempotent-on-`lease_mismatch`; the lease
  expiry sweep makes retry safe); no `blockConcurrencyWhile` in RPC; push indexing runs
  in the Worker, never in the DO.

## 3. R2 key layout

```
repos/<storage_key>/packs/<packName>.pack              # verbatim received/compacted pack
repos/<storage_key>/packs/<packName>.idx               # byte-exact idx v2 sidecar
repos/<storage_key>/staging/pack-rx-<leaseToken>.pack  # in-flight receive (swept on expiry)
repos/<storage_key>/clone-cache/<refsVersionHash>.pack # whole-clone cache (deferred, key fixed now)
```

`storage_key` is the immutable `r_<id>` from D1 (renames never touch storage). Packs
≥16 MiB exist only in R2; the DO keeps index rows only (the 10 GB DO cap is thereby
non-binding — acceptance T6). Binding-name rule: the engine's Env must use the
worker's binding names (`REPO_PACKS`, per wrangler.jsonc — single source of truth);
the vendored `PACK_CACHE` name is renamed in M2 (SPEC-0001a §3 site 11).

## 4. RepoDO schema (drizzle `durable-sqlite`)

- `refs(name PK, oid, peeled, updated_at)`
- `meta(key, value)`: `head`, `refs_version`, `next_pack_seq`, `compaction_wanted_at`
- `pack_catalog(pack_key PK, kind 'receive'|'compact', state 'active'|'superseded',
  location 'r2'|'sqlite', object_count, pack_bytes, idx_bytes, created_at,
  superseded_by)` — small packs (<16 MiB) may stay in DO SQLite (`pack_data`) for
  latency; the location column carries that (SPEC-0001a §8 correction 2)
- object index rows (durable-git `pack_objects` shape, full column set — verbatim
  entry re-emission and idx v2 need all of them): `oid → (pack_key, offset, data_off,
  data_len, entry_size, type, size, base_oid, crc32)` with `(pack_key, offset)` keyset
  ordering for storage-order scans
- `leases(lease_token PK, kind, expires_at, payload)`

D1 (defined in 0002/0003, referenced here): `repositories(id, storage_key, refs_version,
backend='self-hosted', …)`.

## 5. Receive and serve paths

Receive (push): lease from RepoDO (concurrent push → `503 Retry-After: 10`) → parse the
pkt-line command section only; hand the remainder to the R2 stager (16 MiB multipart
parts; `FixedLengthStream` when Content-Length known; trailer SHA-1 verified through a
20-byte sliding window before the multipart completes) → pass 1 scan (streaming single
R2 GET body, per-entry CRC-32, pako `Inflate` raw mode for compressed-byte accounting) →
pass 2 delta resolution (REF_DELTA bases resolved cross-pack to a fixpoint; chain depth
cap; cycle detection) → write idx v2 (byte-equivalent to `git index-pack`) → connectivity
check (commits/trees reachable from the new ref tips; no ref may point into unindexed
storage) → `finalizeReceive` inside the DO: per-command CAS re-check against current
refs (`oldOid` mismatch → `fetch first`), atomic multi-ref commit + catalog row +
`refs_version` bump in one transaction → report-status over sideband. **Ordering rule
(SPEC-0001a §3 Step 1): the Worker copies staging → `packs/` (R2 copy) BEFORE calling
`finalizeReceive`** — a crash between copy and finalize leaves an unreferenced `packs/`
object the orphan sweep reclaims, while the reverse order admits a committed ref
pointing at a missing object. Failures at any
stage: release lease, sweep staging object and non-`active` catalog rows (`waitUntil`
retry path). Protocol: v0/v1 receive advertisement (`capabilities^{}` for empty repos),
`report-status`, `side-band-64k`, `atomic`, `delete-refs`, zero-id create/delete
semantics; thin packs accepted and resolved (dgit ingest phase C). Fast-forward is
client-enforced; force allowed; non-FF without force rejected.

Serve (fetch): v2 advertisement (`ls-refs` with `ref-prefix`/`peel`/`symref`/unborn
HEAD; `fetch` with two-phase negotiation — acknowledgments block on `done=false`, then
pack); `side-band-64k`, `ofs-delta`, `object-format=sha1`; complete (non-thin) packs.
Refs listing cached at edge (Cache API, 60 s) and keyed by `refs_version` so a push
invalidates every cache entry. True full clone with no haves/shallow takes the R2 fast
path: the Worker streams the cached/current pack straight to the client re-framing
sideband; the DO serves only the tiny negotiation. Multi-pack unions stream per pack
(pack count bounded by the compaction trigger, initial K=8).

**API-side commit construction (no push; SPEC-0001a §4).** Tier-1 write endpoints
(SPEC-0004 §3.4 — contents create/update/delete, batch, diffpatch, branch/tag create)
build commits in the Worker and land them through two additional control-plane RPCs:
`putApiObjects` (verify + store into the existing loose `objects`/`chunks` tables via
`GitStore.put`; idempotent, content-addressed) and `commitApiChange` (refname
validation → tip + root-tree presence → CAS → ref write → `refs_version` bump, one
`transactionSync`; HEAD fixup identical to receive). It takes **no receive lease** —
push vs API-write races resolve purely by CAS (loser gets `ref_conflict` +
`currentOid`). The lighter connectivity gate (tip + root tree, not the full closure
walk) is deliberate: the caller is a same-account Worker over a service binding and
every stored object is oid-verified. M3 compaction treats API-written loose objects
as steady-state input, not just GC-migration debris. A third write entry point,
`executeMerge` (0001b §4), constructs merge/rebase commits the same way — derived
loose objects stored via `GitStore.put` inside the landing transaction's build
phase, under the same CAS/`refs_version` machinery.

## 6. Acceptance criteria — defect/solution table (each row is a test)

| # | Defect / risk | Solution (as designed) | Acceptance test |
|---|---|---|---|
| T1 | 5-min CPU ceiling on giant push | Product quota: 1 GiB/pack (config). **Edge reality (empirical 2026-10-24): a 110 MiB stock push to workers.dev fails with HTTP 413 at the Cloudflare proxy — request-body caps (~100 MB non-Enterprise) apply BEFORE the Worker runs, so the effective sync-push ceiling is the plan body limit, not the CPU quota; >100 MB histories must use the SPEC-0003 §2.6 import channel (presigned R2 PUTs bypass the proxy entirely).** Early reject via Content-Length when known; otherwise abort at boundary with sideband fatal; no refs touched. >1 GiB histories go through the SPEC-0003 import channel | Push a 1.1 GiB synthetic pack → clean protocol-level rejection, zero ref changes, staging swept |
| T2 | 128 MB isolate memory | Streaming body (never buffered); idx buffer ≤ ~3 MB; typed arrays + custom OidSet in hot paths; delta chain caps + iterative base walk; pako `chunkSize: 16 KB`; inflate output bounds (~1000:1 bomb ratio) | 42 MiB real-world fixture push and 500 MiB synthetic pack complete with recorded peak memory; decompression-bomb fixture rejected |
| T3 | 1000 subrequests/request | Index scan consumes one streaming R2 GET body; 16 MiB multipart parts (1 GiB ≈ 64 parts); DO calls = lease + finalize only; compaction in Queue consumers (own budget) | Instrumented push of the 1 GiB fixture stays < 200 subrequests |
| T4 | DO single-region RTT | Edge refs cache 60 s keyed `refs_version`; data plane never enters the DO; `locationHint` = R2 region | Second `info/refs` within TTL serves without a DO hit (DO request counter); a push bumps `refs_version` and invalidates the cache |
| T5 | SSH protocol | Not built. Documented exclusion; HTTPS git only | n/a (docs check) |
| T6 | 10 GB per-DO SQLite | Packs ≥16 MiB live only in R2; SQLite holds index rows (~100 B/object) | Push a 32 MiB pack → R2 object present; DO storage growth < idx size |
| T7 | Concurrent pushes to one repo | DO lease; loser gets `503 Retry-After: 10` | Two concurrent pushes: exactly one 503 with header; stock git client retries and succeeds |

Correctness gates (all required): every e2e push followed by `git fsck` clean (dgit
`scripts/e2e.sh` checklist adopted into CI: clone, shallow + unshallow, thin push, force
push, ref delete, atomic multi-ref, `format-patch` roundtrip); stale `oldOid` rejected
("fetch first"); idx v2 byte-equivalence against `git index-pack` on fixtures; crash
between any two stages leaves no dangling refs and the next lease's orphan sweep
reclaims staging + non-`active` rows.

## 7. Fuzzing and security

- pkt-line: strict 4-hex length parsing (reject `parseInt`-style leniency, `0002`/`0003`),
  malformed lengths, truncation.
- pack parser: truncated headers, bogus deltas (bounds-checked copy/literal ops), chain
  cycles, decompression bombs (output bounds), allocation limits.
- `want` oids must be currently advertised (no disclosure of force-pushed/unreachable
  objects); serve only full 40-char reachable oids.
- Refname validation: git's `check_refname_format` rules (`..`, `.lock`, `@{`, `//`,
  255-byte cap).

## 8. Vendoring durable-git

- Copy upstream source into `packages/git-engine/`, preserving its MIT LICENSE and a
  NOTICE recording the upstream commit; we carry patches.
- Adaptations (R2 layout, Worker-side data plane, our DO schema) live behind our own
  port interfaces so upstream diffs stay reviewable.
- Provenance rule: never copy code from ziggit (GPL-2.0). Apache-2.0 sources
  (gitoxide [MIT OR Apache-2.0], gitorange [Apache-2.0]) are allowed with an
  attribution comment, a reference to the upstream license, and a statement of
  changes — the generalization exercised by 0001b §8 category 3.

## 9. Benchmarks — required CI regression stage (per ADR-0001 annex)

Fixtures: 5 MiB / 42 MiB / 500 MiB packs. Metrics per run: clone MB/s, push wall time +
CPU-ms, p95 read latency, peak memory, subrequest counts. First merge records the
baseline; CI fails on >10 % regression — with tolerance classes (as-built
2026-10-28, the calibration commit): fixed-overhead wall metrics (push/fetch
walls as median-of-3, inforefs p50/p95) fail only on >10 % AND >150 ms absolute
(single-shot noise on shared runners swings 73 %+; byte metrics stay pct-only —
they are byte-exact across hosts and carry the teeth). Reference-repo numbers (g1t's 4x pack bloat,
~11 MB/s GitHub clone, dgit memory notes) are leads to sanity-check our baselines
against — not accepted truth.

## 10. Open questions (resolve at implementation, not before)

- Clone-pack cache: build now or defer? Recommendation: defer to the perf iteration;
  the `refs_version`-keyed layout is fixed in §3 so it can be added without migration.
- Compaction trigger K (initial 8 packs) and compaction policy (copy-forward vs
  rebuild).
- SHA1DC collision screening (dgit optional feature): defer; document the tradeoff.
- git-on-cloudflare license verified 2026-10-24: MIT (Copyright 2025 zllovesuki) —
  code borrowing permitted with license preservation; still reference-first.

## Milestones

M1 vendor durable-git, run its e2e suite as-is in CI · M2 receive data plane into the
Worker per SPEC-0001a §3 Steps 1–2 (exact RPC signatures there) · M3 R2 layout +
catalog + leases + schema alignment per SPEC-0001a §3 Steps 3–4 · M3.5 API-side
commit builder per SPEC-0001a §4 (before SPEC-0004 tier-1 write endpoints ship) ·
M4 refs edge cache + clone fast path · M5 fuzz + benchmark CI stage.

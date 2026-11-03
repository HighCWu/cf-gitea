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
backend='self-hosted', …)` — that one line was §4's whole `repositories`
record until the ADR-0007 table-alignment census; the as-built record in
§4.1 below replaces it as the standing description of the D1 row. The
sketch line stays for the cross-references that cite it (e.g. SPEC-0003
§3.1's "additions beyond the SPEC-0001 §4 sketch").

### 4.1 The D1 `repositories` row — the as-built record (2026-11-03)

Derived from the ADR-0007 repositories disposition (the audit's §4
`repository` → `repositories` Tables 1/2, unit GR, upstream pin
`fc4936884584`; applied by unit GU — upstream cites are exact-line at that
pin, ours cites are the worktree `schema.ts`). Applied with four cite
corrections over the staged draft, each re-verified at the pin: `ID` is
repo.go:154 (draft said :153), `OwnerID` :155 (draft :154), `RepositoryReady`
iota :146 (draft :145), and the counters' upstream span is repo.go:167-177
(the draft's stray ":221-222" names the struct's closing brace).
`repositories` (as-built; SPEC-0003 §3.1's original sketch named
`id integer`, `name`/`lower_name`, `is_private` — the landed table diverged
from that sketch; SPEC-0003 §3.1 now carries an as-built note pointing here,
and THIS block is the record of record):

| column | type / notes (ours, schema.ts) | upstream counterpart (models/repo/repo.go, pin `fc4936884584`) | ground |
|---|---|---|---|
| `id` | TEXT pk (schema.ts:33) — the TEXT id-space record is ADR-0007 item 2 (the K11 fact pinned in `3ed025d`); non-upstream shape | `ID int64 pk autoincr` (repo.go:154) | intentional-recorded |
| `storage_key` | TEXT unique NOT NULL (schema.ts:35), `r_<id>`, immutable across renames; all R2/DO addressing | none (upstream derives paths from owner/name on a local disk) | platform-adapted (SPEC-0001 §3 key layout) |
| `owner_namespace` | TEXT NOT NULL (schema.ts:37) — the owner's case-folded slug (repos/service.ts:405), kept in lockstep by the rename/transfer service; the git gate's lookup key | `OwnerName string` (repo.go:156; display case, services/repository/create.go:231) | fold of `owner_name` — the folded-value reduction (fold 2 below) |
| `owner_id` | INTEGER nullable (schema.ts:41) — `users.id`, plain column per the schema conventions | `OwnerID int64 xorm:"UNIQUE(s) index"` (repo.go:155) | parity (nullable-by-ALTER history, ours-looser) |
| `slug` | TEXT NOT NULL (schema.ts:43) — stored case-FOLDED (repos/service.ts:395,407); with `owner_namespace`, the `UNIQUE(owner_namespace, slug)` create/rename arbitration point (schema.ts:248) | `LowerName string xorm:"UNIQUE(s) INDEX NOT NULL"` (repo.go:158); `Name` (repo.go:159) | fold of `lower_name`; the folded `name` carrier (fold 1 below) |
| `visibility` | TEXT enum `public\|private` NOT NULL (schema.ts:45); the API `private` render derives from it (api/services/repository.ts:829) | `IsPrivate bool xorm:"INDEX"` (repo.go:186) | intentional-recorded (SPEC-0004 §3 registry shape; the audit's §2.3 TEXT-enum convention) |
| `default_branch` | TEXT NOT NULL default 'main' (schema.ts:48) | `DefaultBranch string` (repo.go:164) | parity |
| `is_empty` | BOOLEAN NOT NULL default true (schema.ts:51) | `IsEmpty bool xorm:"INDEX"` (repo.go:187) | parity |
| `is_archived` | BOOLEAN NOT NULL default false (schema.ts:53) | `IsArchived bool xorm:"INDEX"` (repo.go:188) | parity |
| `status` | TEXT enum `ready\|creating\|migrating\|broken` NOT NULL default 'ready' (schema.ts:56-58) — mirrors `RepositoryStatus`; upstream 0 = `RepositoryReady` (iota, repo.go:146), so the default value is parity across encodings | `Status RepositoryStatus xorm:"NOT NULL DEFAULT 0"` (repo.go:191) | intentional-recorded (SPEC-0003 §3.1; the §2.3 TEXT-enum convention) |
| `refs_version` | INTEGER NOT NULL default 0 (schema.ts:60) — the denormalized DO mirror (documented exception to no-duplicated-state, SPEC-0003 §3.1) | none | intentional-recorded + platform arm (SPEC-0001 §4/§5, the edge-cache key, acceptance T4) |
| `backend` | TEXT NOT NULL default 'self-hosted' (schema.ts:62) | none | intentional-recorded (ADR-0001 D1 adapter routing; SPEC-0001 §4) |
| `num_issues`/`num_closed_issues`/`num_pulls`/`num_closed_pulls`/`num_milestones`/`num_closed_milestones`/`num_stars`/`num_watches`/`num_forks` | INTEGER NOT NULL default 0 (schema.ts:66-70 + the migrated tallies, e.g. `num_stars` :169) — the SPEC-0005 §3.2 counters + the social tallies (migrations 0027-0061) | repo.go:167-177 (the Num* block; the interleaved `NumOpen*` renders are `xorm:"-"`) | parity |
| `close_issues_via_commit_in_any_branch` | BOOLEAN (drizzle `mode:"boolean"`) NOT NULL default false (schema.ts:73-77) — storage-equal to upstream bool (the audit's §2.4 same-family rule) | repo.go:209 | parity |
| `created_at` / `updated_at` | INTEGER unix seconds (`mode:"timestamp"`; schema.ts:79,85); `updated_at` nullable (the ALTER ADD COLUMN non-constant-default constraint, stamped by the writers) | `CreatedUnix`/`UpdatedUnix` (repo.go:218-219) | intentional-recorded — SPEC-0005 §3.2 as-built item 2 names `repositories` in the `*_at` exception |
| `fork_parent` | TEXT nullable (schema.ts:101; index `repositories_fork_parent_idx` :251) — the source's `repositories.id`; NULL = not a fork (so `is_fork` is derivable and NOT stored); indexed for the fork-list scan | `ForkID int64 xorm:"INDEX"` (repo.go:199) + `IsFork bool` (repo.go:198) | fold of the fork pair — SPEC-0001b §5.2 + the TEXT id family (ADR-0007 item 2) |
| `is_mirror` | BOOLEAN NOT NULL default false | `IsMirror bool xorm:"INDEX"` (repo.go:189) | parity (SPEC-0009 §3.1) |
| `original_url` | TEXT nullable (schema.ts:116) — sanitized source URL | `OriginalURL string xorm:"VARCHAR(2048)"` (repo.go:163) | parity (SPEC-0009 §3.1) |
| `is_template` | BOOLEAN NOT NULL default false — writers: repoEdit PATCH (repo.go:699-701), fork/generate copies, and the CREATE arms (`IsTemplate: opt.Template`, repo.go:253 — the CreateUserRepo funnel, user + org + admin; the FN-4 open note's accepted-and-ignored gap closed) | `IsTemplate bool xorm:"INDEX NOT NULL DEFAULT false"` (repo.go:201) | parity (migration 0027) |
| `size_kb` | INTEGER NOT NULL default 0 (schema.ts:145) — the settled footprint in KiB, scope-parity since the FN-4 port: git + LFS (update.go:110), floored over the byte sum; `git_size`/`lfs_size` carry the split (the LANDED port block below) | `Size int64 xorm:"NOT NULL DEFAULT 0"` (repo.go:203) | fold — scope parity LANDED (fold 4) |
| indexes | `repositories_owner_slug_uq(owner_namespace, slug)` (schema.ts:248) — the arbitration point; `repositories_fork_parent_idx` (:251); `repositories_owner_id_idx`; `repositories_template_id_idx` (the FN-4 port, repo.go:202) | upstream: `UNIQUE(s)` over (OwnerID, LowerName) + the field INDEXes (repo.go:153-220) | the fold's index shape (fold 1 below) |

**The fold records** — the dispositions with no prior SPEC text; each
carries its upstream field line, our schema line, and the SPEC or decision
ground (the ADR-0007 both-side-cite test):

1. **`slug` folds `lower_name` (+ the `name` carrier), folded at write.**
   Upstream keeps a display-case `Name` and a case-folded `LowerName`
   (repo.go:158-159) with `UNIQUE(owner_id, lower_name)` as the arbitration;
   ours keeps ONE name column, `slug`, stored case-folded
   (repos/service.ts:395,407) under `UNIQUE(owner_namespace, slug)`
   (schema.ts:248). Consequences recorded here: (a) the display-case copy
   rides the FN-4 `name` port now (LANDED, migration 0068 — the table row
   below): create/rename/case-only-PATCH stamp it, and the API `name` field
   renders it (upstream parity; the pre-port folded-slug render was the
   recorded gap); the 0068 backfill was the slug copy — display case for
   pre-0068 rows was unrecoverable, accepted and recorded. (b) A separate
   `lower_name` column is declined — it would duplicate the folded slug
   (state duplication, AGENTS.md).
2. **`owner_namespace` folds `owner_name`, folded at write.** Upstream
   `OwnerName` stores the owner's display-case name
   (services/repository/create.go:231); ours stores the folded owner slug
   (repos/service.ts:405, `input.owner.usernameLower`) and keeps it in
   lockstep through rename/transfer. `full_name` renders
   `ownerNamespace/slug` (api/services/repository.ts:820). A separate
   `owner_name` column is declined for the same state-duplication ground.
   (Display-case owner names are carried by `users.display_name` — the API
   owner payload renders that today.)
3. **`is_fork` is derivable, not stored.** `fork_parent` (schema.ts:101) is
   the single nullable edge: NULL = not a fork. The API `fork` field already
   derives (`fork: row.forkParent !== null`, api/services/repository.ts:835,
   matching upstream `Fork: repo.IsFork`, services/convert/repository.go:208).
   Storing the bool would duplicate the edge.
4. **`size_kb` covered `size` at a narrower scope — scope parity LANDED.**
   Upstream's `Size` = git + LFS (update.go:110) with `git_size`/`lfs_size`
   split out (repo.go:204-205); the pre-0068 accounts was the git footprint
   only (schema.ts:145). FN-4's sizes leg LANDED (migration 0068 +
   services/repo-size.ts): the settle persists the triple — `git_size` (the
   R2 walk), `lfs_size` (the lfs_objects sum, GetRepoLFSSize's shape), and
   `size_kb` widened to git+LFS flooring the BYTE sum. The KiB unit stays
   (render divides nothing; upstream divides by 1024 at render,
   services/convert/repository.go:207). The `size_kb` column itself is
   unchanged in shape; only the writer scope moved.

**The FN-4 port columns — LANDED (2026-11-03, migration
`0068_repositories-port-columns` + the writer legs; this block replaces the
staged PENDING record — the FN-6 as-built pattern, the derivation stays in
the audit §4 repositories Tables 1/2).** One additive migration carried all
18 port columns (18 ALTER ADD COLUMN + 1 CREATE INDEX, every add
ALTER-legal; the FN-6 DQS audit applied: pure adds, no INSERT…SELECT copy,
no rebuild). Landed as-built shapes (schema.ts; ours cites = this
worktree):

| column (as-built) | notes |
|---|---|
| `name` | TEXT NOT NULL DEFAULT '' (ALTER-legal constant) — the DISPLAY-case carrier (repo.go:159); create stamps `input.name` verbatim (create.go:238), rename stamps the new name beside the slug (setting.go:261-262 — FY4/M2 corrected the cite; repo.go:666-667 is ComposeTeaCloneCommand territory; incl. the case-only PATCH arm), fork/generate copy it; the 0068 backfill is the slug copy (fold 1's unrecoverable-display-case limitation, now realized) |
| `description` / `website` | TEXT nullable (NULL = no repo_settings row ever existed; the render folds to "") — repo.go:160/161; moved OUT of `repo_settings` (the legacy columns are neither read nor written; loadRepoSettings drops both fields); writers: the PATCH store batch (saveRepoSettings), the create arm, fork copy, generate, migrate; backfill ← repo_settings rows |
| `avatar` | TEXT nullable (repo.go:216, the KEY); the render builds `/repo-avatars/<key>` (avatar.go:85-91), "" on NULL; no writer arm yet — the upload surface is port-when-read |
| `archived_unix` | INTEGER NOT NULL DEFAULT 0 (repo.go:220); stamped both ways by the archive toggle (archiver.go:155-164: now on archive, 0 on unarchive); renders as the API `archived_at` (convert/repository.go:229 — AsTime(0) is the 1970 epoch render, replacing the GO_ZERO_TIME placeholder) |
| `default_wiki_branch` | TEXT nullable (repo.go:165); create seed 'main' (create.go:148 — the instance default); wiki surfaces port-when-read |
| `git_size` / `lfs_size` | INTEGER NOT NULL DEFAULT 0 (repo.go:204/205), the settled split in KiB; maintained by services/repo-size.ts at the settle points — `git_size` = the R2 prefix walk (unchanged), `lfs_size` = SUM(size) over lfs_objects (GetRepoLFSSize, update.go:105-112, keyed by the LFS router's numeric repo id) |
| `num_action_runs` / `num_closed_action_runs` | INTEGER NOT NULL DEFAULT 0 (repo.go:182/183); recounted by services/actions updateRepoRunsNumbers (the UpdateRepoRunsNumbers shape, run.go:258-284 — one UPDATE, two count subselects, never-fails) at the run create settles (trigger/model/invalid-workflow), the status chokepoint (refreshRunStatus — the WorkflowRunStatusUpdate notify tail, notify.go:90), the cancel settle, and the delete arms (retention, repo-actions) |
| `num_projects` / `num_closed_projects` | INTEGER NOT NULL DEFAULT 0 (repo.go:179/180); create = `num_projects + 1` (project.go:282), close/reopen/delete = the recount of both (updateRepositoryProjectCount, project.go:358-375) — the milestone-recount shape; owner-scoped projects never touch the tallies |
| `object_format_name` | TEXT NOT NULL DEFAULT 'sha1' (repo.go:211); create seed 'sha1' (the engine is sha1-only, SPEC-0001 §5); the API render reads the column instead of the constant |
| `original_service_type` | TEXT nullable (repo.go:162; NotMigrated=0/PlainGitService=1, structs/repo.go:346-360 — NULL ≡ 0); TEXT per the §2.3 convention; writer = the SPEC-0009 migrate create arm ('git' — the restricted family's only service); adopt port-when-read (no adopt arm yet) |
| `template_id` | TEXT nullable + `repositories_template_id_idx` (repo.go:202) — TEXT by the id-family extension rule (ADR-0007 item 2 / FN-13 §7.4, the fork_parent precedent; a SHAPE CORRECTION over the audit matrix's INTEGER cell, recorded here); upstream's own surface never writes it nonzero — port-when-read both arms |
| `topics` | TEXT nullable (repo.go:210, the denormalized JSON); backfill = the repo_topics recount (json_group_array, `topic` ASC — the syncTopicsInRepository shape, topic.go:340-352; '[]' for topic-less); the PUT writer maintains it in the same batch (ASC-sorted — the join's order); the API render reads the column with the row (convert/repository.go:265) — the topics half of the list divergence (parity item 3) CLOSED; the /topics route still reads the join (upstream ListTopics does too) |
| `trust_model` | TEXT nullable enum default\|collaborator\|committer\|collaboratorcommitter (repo.go:213, §2.3 — NULL ≡ the default 0); create seed from the form's trust_model (create.go:248); the signing-settings arm port-when-read |

Writer legs by surface owner (code, not DDL): (a) identity/edit — the
create/rename/PATCH arms + the reader flips off repo_settings (the convert
renders `name`/`description`/`website` from the row; the case-only rename
arm stamps the display case without the storage move); (b) counters — the
projects and actions arms above; (c) sizes — the settle triple above,
`size_kb` WIDENED to git+LFS (update.go:110; the total floors the BYTE sum
— floor((g+l)/1024), not the sum of the floored parts); (d) the long-tail —
archived_unix stamp, the create seeds, is_fsck_enabled (create.go:242
`!isMirror` at seed; the settings/fsck-cron arms port-when-read),
original_service_type, template_id.

**schema.ts comment cite errata — RESOLVED (the FN-4 port unit edited
schema.ts; GU's confirmations held):**

- APPLIED: the `isTemplate` comment now cites `models/repo/repo.go:201`
  (the :190 cite confirmed off-by-eleven at the pin).
- DISPROVEN — correctly left alone: the `status` comment's
  `repo.go:146-149` is already exact (RepositoryReady = iota at repo.go:146,
  RepositoryBroken at :149; the audit finding's ":144-149" counted the const
  block's leading comment + `const (` lines).
- RECHECKED at port time (GU flagged :58 suspect): adopt.go's
  `OriginalServiceType: opts.GitServiceType` IS at services/repository/
  adopt.go:58 exactly — verified against the worktree at the pin; no
  erratum. (The cite now lives on the `original_service_type` row above.)

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
2026-10-28, the calibration commit `f7abaa8`): fixed-overhead wall metrics (push/fetch
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

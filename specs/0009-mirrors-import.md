# SPEC-0009: Mirrors & External Imports (outbound git client, migrate, pull-mirror sync)

Status: draft · Date: 2026-10-24 · Extends SPEC-0003 §2.6 (the async chunked import channel —
the data path below is the same machinery driven by an outbound fetch instead of a user
upload). Upstream reference: submodule pin `fc4936884584` (same pin as SPEC-0003; all
`file.go:line` citations are from that pin). Resolves: SPEC-0003 §6 open question 3
("Import channel for external URLs — needs outbound fetch of arbitrary git remotes").
References: `specs/0001-storage-engine.md` §5 (the engine's protocol code, as a SERVER),
`specs/0001a-split-plane-amendment.md` §3/§4 (Worker receive pipeline, CAS landing),
`specs/0001b-merge-fork-primitives.md` §5.4 (a protocol-level transfer between endpoints —
the fork→PR relay proves the "drive our own protocol paths as a client" pattern),
`specs/0002-auth.md` (credential hashing posture), `specs/0005-issues-prs-webhooks.md`
(webhook notify pipeline + egress policy), `specs/0006-lfs.md` (LFS interplay),
`docs/research/tech-route-survey.md` (Workers egress constraints).

## 1. Problem and scope

Gitea lets users create a repository by copying an external git URL, either as a
one-time **import/migrate** or as a **pull mirror** that periodically re-fetches the
source. Upstream implements both with the local `git` binary: migrate runs
`git clone --mirror` (`services/repository/migrate.go:92-102`), mirror sync runs
`git fetch --tags [--prune] origin` on a cron-driven queue
(`services/mirror/mirror_pull.go:124-131`, `services/cron/tasks_basic.go:25-41`).
cf-gitea has no local git binary and no SSH client: the outbound transfer must be a
**git smart-HTTP client** built in the Worker, speaking the same protocol our engine
already serves (SPEC-0001 §5) — ls-refs advertisement parse, fetch negotiation, pack
receive — with the received pack landing through the existing receive pipeline
(SPEC-0001a §3 Steps 1–2) exactly as if it had been pushed.

In scope:

- The outbound smart-HTTP client: protocol v2 primary, v0 fallback; audit of what the
  vendored engine already supplies vs net-new (§2.5).
- `POST /api/v1/repos/migrate` — upstream API shape, restricted (§2.2): https-only
  URLs, git-data-only migration (no forge metadata), queue-driven, target-empty
  validation, mirror row creation when `mirror=true`.
- Pull-mirror scheduled sync (§2.6): cron producer + Queue consumer, interval and
  prune honoring upstream semantics, force-updates, ref deletes, failure states.
- Read-only enforcement for mirror repos (extends the SPEC-0003 §2.4 ACL matrix).
- Webhook `push`-family events per synced ref delta (§2.7).
- SSRF egress policy for source URLs (§4.1) and credential storage (§4.2).
- Edge cases: source unreachable mid-import, upstream force-rewinds, source deletion,
  concurrent sync/import/push (§4).

Out of scope (each a documented divergence or deferral):

- **Forge metadata migration** — issues/PRs/labels/milestones/releases/reviews/wiki
  from Gitea/GitHub/GitLab/… sources. Upstream moves these through per-forge
  downloader crawlers over the source's token APIs
  (`services/migrations/github.go`, `gitlab.go`, …; orchestrated by
  `services/migrations/migrate.go:150-483`) — a large surface orthogonal to the git
  data path, out of scope for v1 (§2.2 documents what we accept instead).
- **LFS mirror sync** — upstream pulls missing LFS objects from the source's LFS
  endpoint during sync (`services/mirror/mirror_pull.go:177-185`). Deferred to a
  SPEC-0006 follow-up: it needs an outbound LFS batch-API *client*; the
  `lfs_enabled`/`lfs_endpoint` columns are created now (§3.1) and reserved.
- **Push mirrors** (our repo → external remote, `models/repo/pushmirror.go:20-32`,
  `services/mirror/mirror_push.go`) — a receive-pack *client* plus outgoing push
  triggers; deferred, tracked as open question 5.
- **SSH / git:// / http:// / file:// source URLs** — https only (Workers have no SSH
  client; SPEC-0001 T5 documents the SSH exclusion; http is denied to keep the egress
  gate and credential handling simple). Documented divergence from upstream, which
  accepts http/git/ssh/file (`services/migrations/migrate.go:46-76`).
- `git-upload-archive` sources and dumb-HTTP sources (no modern server requires them).

## 2. API surface

### 2.1 Upstream model summary (what we are compatible with)

- **Mirror row** (`models/repo/mirror.go:23-38`): `Interval` (duration; `0` disables
  scheduling, `ScheduleNextUpdate` `:71-77`), `EnablePrune` (default true),
  `UpdatedUnix`/`NextUpdateUnix`/`LastSyncUnix`, `LFS` + `LFSEndpoint`, and
  `RemoteAddress VARCHAR(2048)` — the **sanitized** remote URL (userinfo stripped,
  `modules/util/url.go:21-27`), stored alongside the repo's `OriginalURL`
  (`models/repo/repo.go:163`; `UpdateAddress` erases auth before the DB write,
  `services/mirror/mirror_pull.go:64-67`). The repo row carries
  `IsMirror` (`models/repo/repo.go:189`) and a lifecycle `Status` whose
  `RepositoryBeingMigrated` value marks an in-flight migrate
  (`models/repo/repo.go:145-150`, `IsBeingMigrated` `:279-282`).
- **Mirror semantics** are *fetch* semantics, never push: the mirror clone's refspec
  is `+refs/*:refs/*` (the `+` = force every update), sync is
  `git fetch --tags [--prune]` (`mirror_pull.go:124-131`) — so refs deleted upstream
  are deleted locally **iff** prune is enabled, non-fast-forward upstream rewinds are
  applied (force), and everything else is an ordinary fetch. Upstream re-validates the
  remote URL against the egress policy **on every sync**, not only at create
  (`mirror_pull.go:113-121` — "the host may now resolve to an internal IP
  (rebinding) or the allow/block list may have changed").
- **Scheduling**: cron `update_mirrors` every 10m with PullLimit/PushLimit 50
  (`tasks_basic.go:31-38`) iterates due mirrors (`MirrorsIterate`: `next_update_unix
  <= now AND next_update_unix != 0`, oldest-updated first, `models/repo/mirror.go:110-119`)
  into a unique queue (`services/mirror/queue.go:26-43`); per-repo sync is
  globallock-guarded (`mirror_pull.go:284`). Defaults: `MinInterval` 10m,
  `DefaultInterval` 8h (`modules/setting/mirror.go:21-24`). On failure upstream only
  touches the mirror row and creates a system notice (`mirror_pull.go:157-165`,
  `:303-308`) — `next_update_unix` stays due, so the next cron retries.
- **Migrate** (`routers/api/v1/repo/migrate.go`): owner authorization (`:82-99`),
  URL parse + egress gate (`:101-108`, `ParseRemoteAddr` `modules/git/remote.go:74-91`
  merges `auth_username`/`auth_password` into the URL userinfo), `mirror=true` zeroes
  all metadata options (`:159-166`), repo row created immediately with
  `RepositoryBeingMigrating` (`:172-180`), then the migration runs — synchronously
  in-request for the API (`:188-214`), as a queued **task** for the web UI
  (`services/task/task.go:90-140`, with retry `:245-247`). Unknown `service` values
  fall back to the plain-git downloader
  (`services/migrations/migrate.go:129-139`, `services/migrations/git.go:15-44`).
  Git data is `git clone --mirror` regardless of the `mirror` flag
  (`services/repository/migrate.go:92-102`); on success a mirror repo gets its mirror
  row with interval validation against `MinInterval` (`:177-235`) and a
  `+refs/tags/*:refs/tags/*` fetch refspec (`:227-235`), while a non-mirror import has
  the `origin` remote stripped again (`CleanUpMigrateInfo` `:262-288`).
- **Mirror repos reject pushes**: `if !isPull && repo.IsMirror` → `403 "mirror
  repository is read-only"` (`routers/web/repo/githttp.go:202-205`).
- **Sync emits push notifications**: per ref delta upstream fires the same notify
  pipeline as a push — `SyncPushCommits` / `SyncCreateRef` / `SyncDeleteRef`
  (`mirror_pull.go:333-384`), skipping `refs/pull/*` (`:334-336`), commit lists capped
  at `UI.FeedMaxCommitNum` (5, `modules/setting/ui.go:92`, used `:363`).

### 2.2 POST /api/v1/repos/migrate (upstream shape, restricted)

Request body = upstream `MigrateRepoOptions` (`modules/structs/repo.go:419-450`):
`clone_addr` (required), `repo_owner`/`uid`, `repo_name` (required), `service`,
`auth_username`, `auth_password`, `auth_token`, `mirror`, `lfs`, `lfs_endpoint`,
`private`, `description`, `wiki`, `issues`, `milestones`, `labels`, `pull_requests`,
`releases`, `mirror_interval`. Auth to the source: `auth_token` is sent as
`Authorization: Bearer <token>` when the source advertises it failing basic;
otherwise `Authorization: Basic base64(auth_username:auth_password)` — mirroring how
git itself authenticates over HTTP. Credentials in the URL's userinfo form
(`https://user:pass@host/…`) are **rejected** (`422`, documented divergence —
credentials only ever arrive in the structured fields, so they can never leak into
logs, notices, or `original_url`).

Accepted (v1): `service` unset or `"git"`; `mirror` (bool); `private`,
`description`, `repo_owner`, `repo_name`, `mirror_interval`, `auth_username`,
`auth_password`, `auth_token`. `lfs`/`lfs_endpoint` are accepted and stored on the
mirror row but have no effect until the SPEC-0006 client extension lands (§1).
`wiki/issues/milestones/labels/pull_requests/releases` are accepted-but-ignored when
false; when **true** the request fails `422` with a documented message
("metadata migration is not supported for this service") instead of silently
dropping data — upstream's silent-ignore-for-mirrors behavior (`migrate.go:159-166`)
is preserved only for `mirror=true`, where upstream itself zeroes them.

Validation and status codes (upstream texts preserved where upstream has them):

| # | Condition | Response | Upstream cite |
|---|---|---|---|
| 1 | target owner is another user, or org where doer is not owner | `403` "Given user is not an organization." / "Given user is not owner of organization." | `migrate.go:82-99` |
| 2 | URL scheme not https, or fails the egress gate (§4.1) | `422` "You can not import from disallowed hosts." / "The provided URL is invalid." | `migrate.go:101-108`, `handleRemoteAddrError :258-277` |
| 3 | instance flag `MIGRATIONS_DISABLED` / `MIRROR_DISABLE_NEW_PULL` on `mirror=true` | `403` (upstream texts) | `migrate.go:112-120` |
| 4 | name collision | `409` "The repository with the same name already exists." | `migrate.go:226-228` |
| 5 | target repo exists and is not empty / already has an active import | `409` | SPEC-0003 §2.6 import-channel guard |
| 6 | `mirror_interval` below `MIRROR_MIN_INTERVAL` (default 10m) or unparseable | `422` | `services/repository/migrate.go:195-212` |
| 7 | accepted | `201` + Repository JSON (repo in `migrating` state) | see divergence note |

**Divergence — asynchronous migrate.** Upstream's API blocks until the migration
finishes and returns the completed repo (`migrate.go:188-214`, run under a
background context). A Worker request context cannot hold a multi-gigabyte import,
so cf-gitea returns `201` immediately with the repo row in `status='migrating'`
(upstream's exact state value; the web UI already polls this state for its queued
migrations, `services/task/task.go:90-140`, so the official frontend works
unchanged). Completion flips `status='ready'` + `is_empty=false` (§2.6). Failure
follows upstream's task model, not its API model: upstream deletes the repo on a
migration panic (`migrate.go:190-196`) but keeps failed web-UI migrations for
retry — cf-gitea keeps the row in `status='migrating'` with the import at
`state='failed'` + error text visible via `GET …/imports/{id}` (SPEC-0003 §2.6),
supporting re-`start` and `abort` (abort resets to an empty `ready` repo), which
is the task-retry parity. During `migrating`, fetch (`upload-pack`) serves the
empty advertisement and push is `409` (SPEC-0003 §2.6).

### 2.3 Mirror settings endpoints

- `POST /api/v1/repos/{owner}/{repo}/mirror-sync` — enqueue an immediate sync.
  Requires token + code-write (upstream `reqRepoWriter(unit.TypeCode)`,
  `routers/api/v1/api.go:1430`) and a non-archived repo; `400 "Repository is not a
  mirror"` when no mirror row (`routers/api/v1/repo/mirror.go:29-77`); `200` empty
  on enqueue (synchronous, like upstream `AddPullMirrorToQueue`).
- `PATCH /repos/{owner}/{repo}` gains `mirror_interval` (Go-duration string;
  `0` disables scheduling), `enable_prune`, and the write-only credential fields
  `mirror_username` / `mirror_password` / `mirror_token`
  (`routers/api/v1/repo/repo.go:1041-1115`): credentials update the stored ciphertext
  (§4.2), are never echoed back, and an omitted password falls back to the stored
  username+password pair exactly like upstream's recomposition logic (`:1075-1090`).
- Repo JSON additions (SPEC-0004 amendment): `mirror` (bool),
  `mirror_interval` (duration string, `0` = disabled), `mirror_updated` (last sync
  time), `original_url` (sanitized) — upstream `services/convert/repository.go:162,210`.
- Push-mirror routes (`/push_mirrors*`, `api.go:1431-1437`) are not implemented v1;
  they are carried as deferred rows in SPEC-0004's swagger contract inventory
  (documented absence, like SPEC-0003's dumb-HTTP endpoints).

### 2.4 ACL matrix addition (SPEC-0003 §2.4 extension)

| # | Caller | Repo | Op | Response | Upstream cite |
|---|---|---|---|---|---|
| 21 | authenticated with write grant | `is_mirror` repo | P | `403` "mirror repository is read-only" | `routers/web/repo/githttp.go:202-205` |

Row 21 runs where upstream runs it: after the access-permission check, before any
pack byte is read (SPEC-0003 §2.4 rows 8–10 position). Fetch is unaffected — mirrors
serve normally, including anonymous fetch per rows 1–6. Push-create cannot race a
mirror (the repo must exist to be a mirror). `receive-pack` is likewise refused at
the API-side branch/tag/contents endpoints (SPEC-0004 services check the same flag).

### 2.5 The outbound smart-HTTP client

**Audit of the vendored engine (`packages/git-engine/src/`) — what a client gets for
free.** The engine speaks this protocol as a server, and the receive half is
direction-agnostic:

- **pkt-line codec** (`git/pktline.ts:3-67`): `pkt` encoder + strict-hex `PktParser`
  (`:29-41` rejects `parseInt`-style leniency) — shared byte-exact, no changes.
- **Pack receive pipeline** (SPEC-0001a §3 Steps 1–2, implemented):
  `stagePack` → R2 staging with trailer-SHA verification (`mod.ts:500-620`),
  staging→packs copy (`mod.ts:621-640`), `putIndexRows`/scan/delta/idx in the Worker,
  `beginReceive`/`finalizeReceive` (`control-plane.ts:188-334`). The input is *any*
  `ReadableStream<Uint8Array>` — the upstream fetch response demuxed from sideband
  feeds it instead of a request body. Thin packs are accepted and resolved
  cross-pack (SPEC-0001 §5), so mirror syncs can use haves-based thin fetches.
- **CAS landing** (`git/protocol.ts:1246-1341`): `validatePush`/`commitPush` — the
  CAS is `old === current` (`:1286-1289`); non-fast-forward is *detected* (`forced`,
  `:1302`) for GC bookkeeping but **not rejected** ("fast-forward is client-enforced;
  force allowed", SPEC-0001 §5). A mirror therefore expresses force-updates and
  upstream rewinds simply by sending `old = current local tip` — exactly the `+`
  refspec semantics. Ref deletes are `next = ZERO_OID` (`:1291-1294`).
- **HEAD fixup** (`protocol.ts:1343-1351`): main → master → first branch — the same
  rule upstream applies when a mirror sync first populates an empty repo
  (`checkAndUpdateEmptyRepository`, `mirror_pull.go:446-456`). No new code.
- **`updates` from finalize** (`control-plane.ts:320-322`): the applied ref deltas —
  precisely the input the notification step needs (§2.7).

**Net-new client module** (`apps/worker/src/services/mirror/gitclient.ts`; ~550 LOC):

- **Advertisement parse** — v2 `ls-refs` response (oid SP refname [peeled]
  [symref-target], unborn HEAD) ~90 LOC, and a v0 fallback parser (first line carries
  capabilities, `peeled ^{}` continuation lines) ~60 LOC. The engine's `lsRefs`
  renderer (`protocol.ts:224-237`) and `parseUploadRequest` (`:189-222`) are the
  wire-shape references; a client parser is the mirror image, not shared code.
- **Fetch request builders** (~70 LOC): v2 `command=fetch` with
  `want`/`have`/`thin-pack`/`ofs-delta`/`no-progress` + `done`; v0 want/have section
  with `side-band-64k multi_ack_detailed thin-pack ofs-delta agent=` + `done`. One
  negotiation round, always with `done` (stateless; upstream servers answer a
  `done`-round with ACK/NAK + pack, `protocol.ts:586-615` documents both shapes from
  the server side). Haves = current local ref tips (bounded, ≤ 256).
- **Sideband demux** (~60 LOC `TransformStream`): band 1 → pack stream, band 2 →
  progress text (kept in the sync log), band 3 → hard error.
- **Runner** (~150 LOC): injects credentials, `redirect: "manual"` with re-validation
  of every hop (max 5), counting-transform size cap, abort-signal timeout, strict
  content-type checks (SPEC-0003 §2.2 conventions, now asserted on the response side).
- **Advertisement → command synthesis** (~80 LOC): diff advertised refs vs local
  refs → create / force-update / delete(if prune) commands, `refs/pull/*` fetched but
  notification-filtered (§2.7), refname validation failures fail the sync.

**Client-surface estimate:** ~550–600 LOC net-new protocol code vs ~2.5 kLOC of
receive/CAS/pkt-line machinery reused unchanged. The negotiation surface is
deliberately minimal: no multi-round stateless negotiation (always `done`), no
shallow/deepen (mirrors are full-history), no filter expressions, no
`allow-reachable-sha1-in-want` dependence (wants are always advertised tips).

**Where it runs:** the Worker. Negotiation is a few KB of pkt-lines over
`fetch()` (2–3 subrequests). The pack streams through the sideband demux straight
into `stagePack` (R2 multipart, 16 MiB parts) — the same T3-budget path as a push
(< 200 subrequests per 1 GiB, SPEC-0001 §6 T3). Every invocation (queue consumer or
import chunk message) has its own subrequest + CPU budget; nothing holds the request
context of the original API call.

### 2.6 Flows

**Import (one-time migrate; `mirror=true` additionally writes the mirror row).**

1. Handler (§2.2) validates, creates the `repositories` row with
   `status='migrating'`, `is_mirror` per the flag, `original_url` sanitized; creates
   the `repo_imports` row (state `staged`, SPEC-0003 §3.1) and enqueues
   `{kind: "import-negotiate", import_id}`.
2. **Negotiate** (queue consumer): egress re-check (§4.1), `ls-refs` (v2, v0
   fallback). Empty advertisement (`capabilities^{}`) → finalize directly (§2.2 case:
   empty source ⇒ repo stays empty, mirror row still created — upstream parity,
   `mirror_pull.go:419-474` handles the same shape). Advertisement is checkpointed
   into the import row (it is the authoritative `refs` map, replacing the
   user-supplied manifest of SPEC-0003 §2.6); N fetch windows are enqueued, one
   message per window: greedy packing of advertised-but-missing tips into
   ≤ 200 windows (SPEC-0003 §2.6 chunk-count cap), each window's wants = its tips,
   haves = every tip already landed. After each window lands, remaining windows
   re-derive haves (window messages re-read the checkpoint), so later windows
   transfer only deltas.
3. **Window** message: egress re-check → `beginReceive` (synthetic commands for the
   window's tips, `old = ZERO_OID` for new tips) → fetch POST → demux → stage →
   copy → `finalizeReceive` (CAS, connectivity, catalog — the full push pipeline) →
   DO checkpoint (`importCheckpoint`, SPEC-0003 §3.3). Failure → `state='failed'`
   + error, landed windows kept; `POST …/imports/{id}/start` retries only missing
   windows (resume after source outage is free: windows are independent fetches).
4. **Finalize** message: connectivity across all landed packs (engine primitive,
   SPEC-0003 §2.6 step 3) → one DO transaction writing **all** advertised refs
   (zero-id creates), `meta.head` from the source advertisement's `symref=HEAD`
   (v2 `ls-refs` symref; v0: source HEAD is unknown to the protocol — fall back to
   the §2.5 HEAD-fixup rule), `refs_version` bump → D1: `is_empty=false`,
   `default_branch`, `status='ready'`; if `mirror=true`, insert the `repo_mirrors`
   row (§3.1) with `next_sync_at = now + interval` — the exact ordering upstream
   uses when `MigrateRepositoryGitData` inserts the mirror model
   (`services/repository/migrate.go:177-235`). Emit the import-complete
   notification (upstream `notify_service.MigrateRepository`, `migrate.go:203`).

**Pull-mirror sync (scheduled or `mirror-sync` API).** One queue message per sync
(it is a delta — small; the initial population is always the import flow above):

1. Consumer loads the mirror row + repo; row missing → done (delete raced it).
   `sync_state` CAS to `syncing` (D1 conditional update — the enqueue guard already
   filtered duplicates; this re-guard covers `mirror-sync` API racing the cron).
   Egress re-check of the stored URL (§4.1; upstream re-validates every sync,
   `mirror_pull.go:113-121`).
2. `beginReceive` on the RepoDO: a concurrent operation can only be another sync
   (pushes are refused, §2.4) — `busy` → release and requeue with delay
   (the lease's `Retry-After` semantics, SPEC-0001 §6 T7).
3. `ls-refs` → diff vs current refs → commands (force-updates, creates, deletes iff
   `enable_prune`). No missing tips → skip the fetch POST entirely (prune-only sync).
4. Fetch → demux → stage → copy → `finalizeReceive` with `old = current tip`
   per ref (force semantics, §2.5). CAS failure (`fetch first`) → another writer
   won the race: requeue once, then fail the attempt.
5. Notifications from `updates` (§2.7). D1: `last_sync_at = now`,
   `next_sync_at = now + interval` (`0` interval → stays unscheduled),
   `sync_state='idle'`, clear `last_error`. On failure: `last_error` set (URL
   sanitized), `sync_state='idle'`, `next_sync_at` left due (≤ now) so the next cron
   retries — upstream's retry posture (`mirror_pull.go:303-308`), plus the
   admin-notice-equivalent log (SPEC-0003 §2.5.5 step 3 pattern).

**Scheduling.** A cron trigger (every 10m, matching upstream's default,
`tasks_basic.go:35`) runs the producer: `SELECT` due mirrors
(`next_sync_at <= now AND next_sync_at != 0 AND sync_state = 'idle'`, oldest
`last_sync_at` first, `LIMIT 50` — upstream `MirrorsIterate` + PullLimit), conditional
`UPDATE … SET sync_state='queued'` per row (CAS wins the right to enqueue), then
`QUEUE.sendBatch` (≤ 100 messages per call; chunked). Queue redelivery is safe:
every step re-checks state and the receive lease serializes writers.

### 2.7 Webhook events from mirror sync

Mirror syncs emit the same push-family notifications as user pushes, from the
`FinalizeCommitted.updates` delta: per created ref → the create-ref event; per
deleted ref → the delete-ref event; per updated ref → the push event with the
old→new commit list (bounded, `FeedMaxCommitNum`-style cap of 5), exactly upstream's
split (`mirror_pull.go:333-384`). `refs/pull/*` deltas are **fetched but never
notified** (upstream `:334-336` — GitHub's PR refs ride the mirror refspec). The
SPEC-0005 webhook service is driven by the notify pipeline it already exposes for
receive `onPush` — mirror sync reuses that entry point verbatim; delivery stays in
the SPEC-0005 Queue with its egress policy.

## 3. Data model

### 3.1 D1 (additions to SPEC-0003 §3.1)

`repositories` gains two columns: `is_mirror` (bool, default false — upstream
`models/repo/repo.go:189`) and `original_url` (VARCHAR 2048, sanitized — the
`OriginalURL` column, `:163`). `status` already carries `'migrating'`
(SPEC-0003 §3.1).

`repo_mirrors` (new; upstream `Mirror`, `models/repo/mirror.go:23-38`):

| column | type / notes |
|---|---|
| `id` | integer PK autoincrement |
| `repo_id` | → repositories.id, **UNIQUE** (one pull mirror per repo; upstream `GetMirrorByRepoID` assumes ≤ 1, `mirror.go:80-88`) |
| `interval_seconds` | integer; `0` = disabled (upstream `Interval`/`ScheduleNextUpdate`, `mirror.go:71-77`); validated ≥ `MIRROR_MIN_INTERVAL` (default 600) unless 0 |
| `enable_prune` | bool NOT NULL default true |
| `lfs_enabled`, `lfs_endpoint` | reserved (§1) — upstream `mirror.go:34-35` |
| `remote_address` | VARCHAR 2048, sanitized (userinfo stripped, `modules/util/url.go:21-27`) |
| `credentials_username` | text nullable (not secret; upstream keeps it in the remote URL) |
| `credentials_ciphertext` | text nullable — AES-256-GCM over the secret, §4.2 |
| `sync_state` | `'idle' \| 'queued' \| 'syncing'` — enqueue/serialization guard |
| `next_sync_at`, `last_sync_at` | integer epoch seconds (upstream `NextUpdateUnix`/`LastSyncUnix`); `next_sync_at = 0` = unscheduled |
| `last_error` | text nullable (sanitized) |
| timestamps | `created_at`, `updated_at` |

`repo_imports` / `imports_checkpoints` (DO SQLite) are SPEC-0003 §3.1/§3.3 tables,
reused: the `manifest` JSON now carries the fetched advertisement (refs map + HEAD
symref) instead of a client-supplied manifest; chunk semantics = fetch windows.

### 3.2 R2 keys

No new key shapes. Import/sync staging rides the receive staging layout
`repos/<storage_key>/staging/pack-rx-<leaseToken>.pack` (SPEC-0001 §3) — a fetch
window *is* a receive; there is no separate `imports/` prefix (only the
user-upload variant of the SPEC-0003 channel uses it). Delete purge needs no change:
`repos/<storage_key>/` covers everything.

### 3.3 Durable Objects, Queues, config

- RepoDO unchanged: `beginReceive`/`finalizeReceive`/`importCheckpoint`/`importFinalize`
  already exist (SPEC-0001a §3, SPEC-0003 §3.3). `importFinalize`'s ref source is the
  fetched advertisement.
- Queues: the SPEC-0003 import consumer gains the `import-*` message kinds above; one
  new binding `MIRROR_SYNC_QUEUE` for sync messages (own consumer, own budgets).
  Cron: one entry `*/10 * * * *` for the producer (§2.6) — added to
  `wrangler.jsonc` `triggers.crons` (single source of truth per AGENTS.md).
- Settings (instance config, D1 settings table per 0002/0004 pattern):
  `MIRROR_MIN_INTERVAL` (600 s), `MIRROR_DEFAULT_INTERVAL` (28800 s — upstream 8h,
  `modules/setting/mirror.go:24`), `MIRROR_DISABLE_NEW_PULL`,
  `MIGRATIONS_DISABLED`, `MIGRATIONS_ALLOWED_HOSTS` / `MIGRATIONS_BLOCKED_HOSTS`
  (upstream `migrations.ALLOWED_HOST_LIST`/`BLOCKED_HOST_LIST` semantics),
  `IMPORT_MAX_TOTAL_BYTES` (50 GiB) / `IMPORT_MAX_CHUNKS` (200 — SPEC-0003 §2.6).
  Secret: `MIRROR_CREDENTIAL_KEY` via `wrangler secret` (§4.2).

## 4. Edge cases, limits, failure modes

### 4.1 SSRF egress policy (source URLs)

Same posture as webhook targets (SPEC-0005 §3 "Egress": instance allow-list setting,
loopback/metadata denied by default), ported to upstream's migration policy
(`modules/egress/policies.go:23-34,78-84`):

- **Scheme**: https only (§1). Rejected before any resolution: opaque URLs, other
  schemes (upstream's protocol check, `services/migrations/migrate.go:70-72`), the
  git-scheme CRLF smuggling upstream blocks (`:66-68`), userinfo in the URL (§2.2).
- **Host gate**: literal IPs and resolved names are checked against denied ranges —
  loopback, RFC 1918, link-local 169.254/16 (metadata), CGNAT 100.64/10, ULA,
  `*.local`, `*.internal`, IPv4-mapped IPv6 — unless an explicit **IP allow entry**
  covers them (upstream `WithLocalNeedsIPAllow`: a host-name match is not enough for
  non-public targets, `modules/egress/policy/policy.go:59-66`). Then the
  allow/block host lists apply. Resolution uses DoH (`cloudflare-dns.com/json`,
  one subrequest, cached per host for the interval); **residual risk**: Workers
  `fetch()` re-resolves independently, so unlike upstream's dial-time check
  (`policy.go:199-201`, anti-rebinding) a full TOCTOU window cannot be closed in
  user-space — documented, accepted, and mitigated by the fact that Workers egress
  cannot route to RFC 1918 targets anyway; re-validated `redirect: "manual"` hops
  (§2.5) close the redirect-to-internal vector.
- **Re-check on every sync** (§2.6), so a allow-list change or a source that starts
  resolving internally stops future syncs (upstream `mirror_pull.go:113-121`).
- The LFS endpoint URL gets the identical gate at accept time (upstream
  `migrate.go:124-135`) and will at use time when the LFS client lands.

### 4.2 Credential storage (decision)

Upstream stores source credentials **in the repo's git config** (`remote.origin.url`
with embedded userinfo — plaintext on disk; only the DB copies are sanitized:
`UpdateAddress` erases auth before the DB write, `mirror_pull.go:64-67`, and
`RemoteAddress` is `SanitizeURL`'d, `services/repository/migrate.go:179-189`).
cf-gitea has no git config to hide them in and must **use** the secret on every
sync, so hash-at-rest (the SPEC-0002 token posture, sha256 digests —
`specs/0002-auth.md` "Hashing decision") is impossible: a digest cannot authenticate
an outbound request. **Decision: AES-256-GCM ciphertext in D1** (`credentials_ciphertext`),
keyed by a KEK held in `wrangler secret` (`MIRROR_CREDENTIAL_KEY`, outside D1
backups/exports), with AAD binding `(mirror_id, repo_id)` so a ciphertext cannot be
moved between rows. Decryption happens only inside the sync/import consumer, in
memory, never logged (log URLs via the sanitizer everywhere — upstream's
`SanitizeCredentialURLs` discipline, `mirror_pull.go:72-75`). API responses never
return secrets; the write-only PATCH fields (§2.3) are the only path in.
Cloudflare Secrets Store as the KEK store is the alternative if available at
implementation (open question 3).

### 4.3 Edge-case table

| # | Case | Behavior |
|---|---|---|
| 4.3.1 | **Source unreachable mid-import** | Windows are independent fetches with DO checkpoints (§2.6 step 3); a dead source fails the current window, `state='failed'`, landed windows persist; `start` resumes against the checkpointed advertisement (re-negotiating if the advertisement itself was never checkpointed). Heartbeat timeout 24 h + orphan sweep as SPEC-0003 §2.6 step 5. |
| 4.3.2 | **Upstream force-rewind** | Mirror commands carry `old = current tip`; the engine's CAS matches and the forced update lands (`validatePush` marks `forced`, GC triggered, reachable cache invalidated — `protocol.ts:1302,1337,1360-1363`). Parity with the `+refs/*:refs/*` refspec. |
| 4.3.3 | **Source deletes a ref** | With `enable_prune` the sync issues a delete command (`next = ZERO_OID`); without it the local ref survives — upstream `git fetch` without `--prune`, `mirror_pull.go:124-131`. |
| 4.3.4 | **Source deleted / gone forever** | Syncs fail with sanitized `last_error`; mirror row stays, repo keeps serving the last-fetched data (mirrors are snapshots — upstream creates a notice and keeps serving, `mirror_pull.go:157-165`). User recourse: delete the repo or clear the mirror via future admin surface. |
| 4.3.5 | **Concurrent push to a mirror** | Impossible by construction: row 21 rejects pushes (`403 read-only`, §2.4) — upstream's is_mirror check is the same guard (`githttp.go:202-205`). Sync-vs-sync is serialized by the receive lease + `sync_state` CAS (§2.6). Sync-vs-import: an active import refuses sync enqueues and vice versa (one active operation per repo, SPEC-0003 §2.6 discipline). |
| 4.3.6 | **Import vs user activity** | During `status='migrating'` the repo advertises empty (fetch OK), push is `409` (import in progress, SPEC-0003 §2.6/§4.9), API edits `409`. On permanent import failure the repo stays `migrating` + `failed` for retry/abort (§2.2 divergence note); `abort` resets to an empty `ready` repo. |
| 4.3.7 | **refs/pull/* from GitHub sources** | Fetched (full-ref mirror parity) but filtered from notifications (§2.7). Open question 4 asks whether to stop fetching them via ref-prefix filters for bandwidth. |
| 4.3.8 | **Source HEAD moves** | HEAD is set once at import from the source's `symref=HEAD`; syncs never move `meta.head` unless it dangles (the §2.5 fixup rule). Upstream parity: `git fetch` does not update a mirror's HEAD. |
| 4.3.9 | **Single ref whose pack exceeds the 1 GiB engine quota** | The window fails with the engine's early-reject (SPEC-0001 §6 T1); the import fails with a documented limit message pointing at the SPEC-0003 §2.6 chunked-push channel for >1 GiB-single-ref histories. Splitting one upload-pack response server-side is impossible without arbitrary-sha1 wants (§2.5) — accepted v1 limit. |
| 4.3.10 | **Advertisement too large** | Advertisement buffer capped at 8 MiB (~100k refs) → sync fails with `last_error`; import fails per the 10k-ref/1 MiB manifest caps it reuses (SPEC-0003 §2.6). |
| 4.3.11 | **Credential rotation upstream** | PATCH credential fields (§2.3); next sync uses the new ciphertext. A sync failing auth keeps retrying per §2.6 (upstream posture) — no lockout cascades (the source is external; SPEC-0002's failure-limiter is per-instance-auth, not egress). |
| 4.3.12 | **Mirror repo renamed/transferred** | Nothing: mirror state is `repo_id`-keyed; the URL/egress state is name-independent (SPEC-0003 §4.3). |
| 4.3.13 | **Mirror row deleted (convert to normal repo, admin op)** | Out of scope v1 (no conversion surface); the cascade clause in SPEC-0003 §2.5.5 step 1 gains `repo_mirrors` so repo deletion removes the row, and in-flight syncs no-op on the missing row (§2.6 step 1). |

Limits: one fetch window ≤ 1 GiB (engine pack quota), import totals per SPEC-0003
§2.6 (50 GiB / 200 chunks default), sync pack ≤ 1 GiB (a delta sync is orders smaller;
a sync exceeding it means the source rewrote history massively — it fails like
4.3.9 and the next sync retries), `ls-refs`/advertisement ≤ 8 MiB, negotiation
haves ≤ 256 tips per round, sync wall-time bounded by the consumer budget with the
lease TTL (15 min, `control-plane.ts:135`) as the backstop.

## 5. Testing plan

Unit/worker tests (`@cloudflare/vitest-pool-workers`, real D1/DO/R2):

- **Client protocol against golden fixtures** (recorded once from a real
  `git upload-pack --advertise-refs` / `--stateless-rpc` exchange, committed as
  bytes): v2 ls-refs parse (peeled tags, symref, unborn HEAD), v0 advertisement
  parse (capabilities on first line, `^{}` peel lines), malformed pkt-line lengths
  rejected (shared codec tests already cover the parser; the fixtures pin the
  client's expectations), sideband demux (bands 1/2/3, frame boundaries split
  across reads), fetch request builder bytes (want/have/done, cap set) asserted
  against a recording.
- **Command synthesis**: advertisement vs local refs diff → create/update/delete
  table, prune on/off, refs/pull notification filter, funny-refname failure.
- **SSRF gate**: scheme/opcode/userinfo rejection; literal + DoH-resolved private
  ranges (loopback, 169.254.169.254, 10/8, 100.64/10, ULA, `.internal`) denied;
  explicit IP allow entry admits loopback for tests; redirect hop to a denied host
  aborted; block/allow list precedence. (Tests inject a fake DoH resolver.)
- **Credential crypto**: roundtrip, wrong AAD (row swap) rejected, KEK absent →
  sync fails cleanly, PATCH write-only fields never echoed in any response.
- **Sync state machine** (fake upstream = a Worker-route git server in-test, see
  e2e below): due-select + enqueue CAS (no double-enqueue under contention),
  lease-busy requeue, failure leaves `next_sync_at` due with `last_error`,
  success schedules `now + interval`, interval `0` never schedules.
- **Import flow**: negotiate → windows → finalize on an empty target; resume after
  killing a window consumer; empty-source advertisement; migrating-state fetch
  serves empty, push `409`; abort resets.

E2e (real git; extends the SPEC-0003 §5 checklist):

1. **Local source server**: a small Node harness (`test/fixtures/git-http-server.mjs`,
   CI-only) that shells `git upload-pack --stateless-rpc [--advertise-refs]` per
   request over plain HTTP on loopback — a real smart-HTTP endpoint driven by real
   git, no cloud dependency; the engine e2e's real-git discipline (SPEC-0001 §6)
   applies unchanged. (Unit paths use committed fixtures; `file://` is never a
   client scheme.)
2. Migrate a fixture bare repo (`mirror=false`) → `201` migrating → poll `ready` →
   `git clone` + `git fsck` + `rev-list --count` equal the source; `original_url`
   set; no mirror row.
3. Migrate with `mirror=true`, default interval → repo `ready`, mirror row due;
   push a new commit to the source; `POST …/mirror-sync` → the new commit appears,
   `git fsck` clean, webhook push event observed (SPEC-0005 delivery log) with
   `refs/pull/*` excluded when the fixture carries one.
4. Force-rewind the source branch (upstream `reset --hard` + `push --force`) → sync
   applies the rewind; delete the source branch → sync with prune removes it, with
   `enable_prune=false` it survives.
5. Kill the source → sync records sanitized `last_error`, repo still clones.
6. `POST /git-receive-pack` to the mirror → `403` "mirror repository is read-only"
   (row 21, §2.4); API branch-create → `409`-equivalent refusal.
7. SSRF: migrate pointing at `http://…`, `https://127.0.0.1/…`,
   `https://foo.internal/…` (fake DoH) → `422` "You can not import from disallowed
   hosts."; redirect-to-internal during the real fetch → aborted, import failed.
8. Budget assertion: a 500 MiB fixture import completes in one window with the T3
   instrumentation under the same subrequest cap as a push (< 200).

## 6. Open questions (resolve at implementation)

1. **DoH resolver choice and caching**: `cloudflare-dns.com/json` per host with a
   TTL-honoring cache vs a Workers KV cache; the gate's correctness must not depend
   on cache freshness (denied-by-default on resolution failure).
2. **v0 fallback necessity**: every realistic source (GitHub, GitLab, Gitea, git ≥
   2.18) speaks v2; if the v0 path complicates the runner, ship v2-only and record
   the divergence instead.
3. **KEK location**: `wrangler secret` env vs Cloudflare Secrets Store binding —
   pick whichever is GA-stable at implementation; the AES-GCM envelope format is
   identical.
4. **Fetch scope for `refs/pull/*`**: keep upstream parity (fetch, don't notify) or
   exclude via v2 `ref-prefix` filters to save bandwidth on GitHub sources (would
   diverge from "mirror = complete ref copy").
5. **Push mirrors** (§1): the receive-pack client (~200 LOC on top of §2.5's
   builders + `uploadPack`'s pack generation as the sender) and `sync_on_commit`
   triggers; separate SPEC when scheduled.
6. **Webhook event naming**: whether mirror-sync creates/deletes surface as
   dedicated event types or as `push`-payload variants (SPEC-0005 taxonomy owns the
   decision; upstream models them as `SyncPushCommits`/`SyncCreateRef`/`SyncDeleteRef`,
   `mirror_pull.go:347-358`).

## Milestones

M1 outbound client (§2.5) + golden fixtures + SSRF gate · M2 migrate API + import
flow over the SPEC-0003 channel (§2.6) with retry/abort · M3 mirror rows + cron
producer + sync consumer + read-only enforcement (§2.4) · M4 notifications + API
settings (§2.3) + e2e suite (§5) green.

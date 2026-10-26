# SPEC: Outbound Push Mirroring (the Worker as a git push client)

Status: **LANDED** (wave-28 `wave-pushmirror-outbound-impl`, 2026-10-26 — see
§9 Resolutions). Design of record for the outbound push-mirror sync — the
follow-up that `apps/worker/src/api/services/push-mirrors.ts` (module header)
and SPEC-0009 §6 open question 5 both declare. Companion to SPEC-0009 (pull
direction already landed: outbound fetch client, migrate, pull-mirror sync)
and to the landed push-mirror CRUD + enqueue trigger (8f0aa90,
`src/api/routes/push-mirrors.ts`).

Upstream references are at the submodule pin `fc4936884584a41931906553d96c2601d750e6ef`.

---

## 1. Problem and scope

### 1.1 Problem

A `push_mirrors` row (migration 0023) says "keep remote X identical to this
repo". Today the only live behavior is the enqueue: `repoPushMirrorSync` sends
one `{kind: "push-mirror-sync", repoId, pushMirrorId}` message per row on
`MIRROR_SYNC_QUEUE` (physical queue `repo-tasks`), and the landed consumer
ACKs-and-drops it (`apps/worker/src/repos/purge.ts` `handleRepoTasks` has no arm
for the kind; the route module header documents the divergence). Nothing ever
sets `last_update_unix` or `last_error` on a push mirror row. This SPEC designs
the missing half: a queue consumer that, per mirror row, pushes our refs to the
remote over HTTPS as the client side of git-receive-pack, then settles the row.

### 1.2 What turns on

- **The sync consumer's real push**: a `push-mirror-sync` arm in the REPO_TASKS
  dispatch (`src/repos/purge.ts`) driving a new orchestrator
  `src/services/mirror/push-sync.ts` (`handlePushMirrorSync`) + protocol client
  `src/services/mirror/pushclient.ts`.
- **The cron producer**: due `push_mirrors` rows (`interval_seconds != 0`) are
  selected and enqueued from the existing 10-minute `scheduled` handler
  (`src/index.ts:133-135` — today it only enqueues pull syncs), upstream
  `PushMirrorsIterate` parity (`gitea/models/repo/pushmirror.go:147-160`).
- **The `sync_on_commit` producer**: rows with `sync_on_commit = true` enqueue on
  every user push to the repo — upstream
  `syncPushMirrorWithSyncOnCommit` (`gitea/services/mirror/mirror_push.go:250-260`)
  → `GetPushMirrorsSyncedOnCommit` (`pushmirror.go:140-145`). Our hook point is
  the entrypoint engine's `onPush` event (already wired to
  `handleUserPushEvent`, `src/index.ts:39-44`); the enqueue rides after it.
- **last_error / last_update surfacing** through the already-landed API
  (`toApiPushMirror` renders both).

### 1.3 What stays out (v1)

- **SSH remotes** — no SSH client exists on Workers; the landed target gate is
  https-only (`checkPushMirrorTarget`, `src/api/services/push-mirrors.ts:190-213`
  rejects every non-https scheme). Out, permanently for v1.
- **`git://` remotes** — same gate rejects them; Workers egress cannot honor
  arbitrary schemes. Out.
- **Credential classes beyond Basic** — `CreatePushMirrorOption` carries only
  `remote_username`/`remote_password` (upstream
  `modules/structs/mirror.go:8-20` has no token field either); the sealed
  envelope stores the composed `Basic` header value (§5.1). SSH keys / host
  verification are out with SSH itself.
- **Outbound LFS push** — upstream pushes LFS objects when
  `setting.LFS.StartServer` (`mirror_push.go:138-154`, `pushAllLFSObjects`); we
  have no outbound LFS batch client (SPEC-0006 follow-up). Out; the git push
  carries pointer blobs only (which is exactly what a non-LFS remote expects).
- **Wiki mirroring** — upstream pushes the wiki repo through a second
  `performPush` (`mirror_push.go:175-180`). cf-gitea push mirrors target the
  code repo only (wiki parity is an open question, §8.8).
- **ref-batch chunking** of oversized pushes — designed as an escape hatch
  (§6.9) but not landed in v1 unless the size budget demands it (§8.6).

---

## 2. The protocol analysis (the core)

### 2.1 What upstream actually does at the pin

Upstream does NOT implement the receive-pack protocol in Go. `runPushSync`
(`gitea/services/mirror/mirror_push.go:122-183`) ends in
`git.PushToExternal(..., git.PushOptions{Remote: m.RemoteName, Force: true,
Mirror: true, Timeout: timeout})` (`mirror_push.go:158-165`), which shells out
to the git binary: `git push -f --mirror <remote>` (`gitea/modules/git/repo.go:238-260`;
`PushToExternal` at `modules/git/push.go:13-15`). The registered remote carries
the refspecs `+refs/heads/*:refs/heads/*` and `+refs/tags/*:refs/tags/*`
(`AddPushMirrorRemote`, `mirror_push.go:32-41`) — but with `--mirror` on the
command line, git ignores configured push refspecs and mirrors **all refs under
`refs/`**, pruning whatever the remote has that the local side does not
(git-push(1), `--mirror`: "all refs under refs/ ... deleting whatever is on the
remote that is not on the local side"; equivalent to `--prune` plus force on
every ref). cf-gitea has no git binary, so the client side of the protocol must
be implemented in TypeScript on Workers. That is this SPEC.

Sync lifecycle upstream: `SyncPushMirror` (`mirror_push.go:77-120`) clears
`LastError`, runs `runPushSync`, then sets `LastUpdateUnix = now`
**unconditionally on success and failure** (`mirror_push.go:110`) and persists
exactly `{last_update, last_error}` via `UpdatePushMirrorSyncStatus`
(`pushmirror.go:81-85`). Failure text is credential-sanitized
(`util.SanitizeErrorCredentialURLs`, `mirror_push.go:105`) with the
`exit status N - ` prefix stripped (`stripExitStatus`, `:29`).

### 2.2 Wire walkthrough (client side of git-receive-pack over HTTP)

Sources, stated inline: git's wire documentation —
`Documentation/gitprotocol-http.txt` (smart client discovery and content
types), `Documentation/gitprotocol-pack.txt` (ref advertisement, update
commands, packfile rules, report-status), `Documentation/gitprotocol-v2.txt`
(protocol v2 covers fetch/ls-refs only; receive-pack is unchanged, so push
discovery is **v0 only**). Every shape below is additionally verifiable against
our own engine, which implements the server side of the same documents
(`packages/git-engine/src/git/protocol.ts` `advertisement`/`receivePack` path in
`mod.ts`; the engine's loopback responses are the round-trip test oracle, §7).

**Step 1 — ref advertisement (READ from the remote).**
`GET {remote}/info/refs?service=git-receive-pack` with the Basic auth header
(§5.1). Success is `200` with `Content-Type:
application/x-git-receive-pack-advertisement`; the body is pkt-lines:

```
# service=git-receive-pack\n   <flush>
<oid> SP <refname> [NUL caps]  (first line carries the capability list)
... ref lines ...
<zero-id> SP capabilities^{} NUL caps   (only when the remote repo is empty)
<flush>
```

The v0 grammar, `^{}` peel continuation lines, and the zero-id
`capabilities^{}` empty-repo line are exactly what the pull client already
parses (`parseInfoRefsAdvert`, `src/services/mirror/gitclient.ts:247-317`) —
the push client reuses that parser verbatim with the receive service URL; the
preamble detection (`# service=`) is service-agnostic. Capabilities we care
about on the remote: `delete-refs` (gate for delete commands),
`object-format=sha256` (fail the sync cleanly — the engine store is SHA-1
only), `report-status`/`report-status-v2` (asked back on the POST), `atomic`,
`push-options`, `quiet` (all ignored). For reference, our own engine advertises
`report-status delete-refs ofs-delta side-band-64k agent=…`
(`protocol.ts:73`).

No v2 attempt is made for push (gitprotocol-v2 leaves receive-pack at v0; the
engine's own renderer also emits v0 for the receive service regardless of the
`v2` flag, `protocol.ts:59-62`). The `git-protocol: version=2` request header
the pull runner sends is harmless but pointless here — omit it.

**Step 2 — compute the delta (advertisement vs ours).**
Diff the remote's advertised refs against our local tips (from
`env.REPO.getByName(...).listRefs()`, the same RPC the pull sync uses) into:

- **creates** — a ref we have that the remote does not advertise → create
  command `old = ZERO_OID, new = our tip`;
- **updates** — both sides have the ref, tips differ → command
  `old = <remote's advertised oid>`, `new = <our tip>`;
- **deletes** — the remote has a ref we lack → command
  `old = <remote's advertised oid>`, `new = ZERO_OID`, only for refs inside the
  pushed namespaces (§2.3).

`old` MUST be the remote's current oid — receive-pack is a per-ref CAS on the
server (`gitprotocol-pack.txt` update-commands grammar; our engine enforces
`current !== cmd.old → ng fetch first` at `protocol.ts:1558-1560, 1598-1601`).
There is no "force" flag on the wire: force is a *client-side* decision in
git-send-pack (whether to send a non-fast-forward update at all, git-push(1)
`--force`); a server accepts any well-formed update whose `old` matches current
unless configured otherwise (`receive.denyNonFastForwards` → `ng <ref>
non-fast-forward`). Mirror force semantics therefore reduce to: always send the
update, with `old := remote's advertised tip`. HEAD is never planned (the pull
planner's rule, `planMirrorSync` gitclient.ts:1056 — mirrors do not move HEAD).

**Step 3 — generate the pack (the missing objects).**
The pack must contain exactly the objects reachable from our new tips and not
from the oids the remote advertised (its tips plus the `^{}` peeled targets of
annotated tags). Whether any pack bytes are needed at all: creates/updates with
a non-zero object delta need a pack; a **deletes-only request carries no
packfile** — `gitprotocol-pack.txt`: "The packfile MUST NOT be sent if the only
command used is `delete`." Our engine observes the same convention
(`pack.packBytes === 0` denotes deletes-only, NOTICE.md Step-1 conventions;
`mod.ts:1011` skips staging when the command section had no pack).
Reuse verdict in §2.4, request assembly in Step 4.

**Step 4 — POST the receive-pack request.**
`POST {remote}/git-receive-pack`, `Content-Type:
application/x-git-receive-pack-request`, `Accept:
application/x-git-receive-pack-result` (gitprotocol-http.txt). Body
(the *request* pack is raw bytes, never sideband-framed):

```
<old> SP <new> SP <ref> NUL caps\n   (first command carries the capabilities)
<old> SP <new> SP <ref>\n            (remaining commands)
<flush>
[ raw packfile bytes ]               (omitted for deletes-only)
```

Capabilities to request: `report-status delete-refs agent=cf-gitea-mirror/1`.
Notably NOT: `side-band-64k` (the response then arrives as plain pkt-lines —
simpler parse, §2.5), `thin-pack` (our pack is self-contained by construction,
§2.4 — asking for thin would invite the *server* to... nothing, thin is a
fetch-direction capability; it simply has no role here), `ofs-delta` (we never
emit ofs-deltas; stored ofs-delta entries are inflated when their base does not
ship in the same pack), `atomic` (upstream mirrors are not atomic; a partial
apply is reported per-ref and handled as a failure, §6.5).

The body is a **stream** — command section prefix concatenated with the pack
stream — using exactly the `prependStream` composition the pull sync's internal
receive already implements (`src/services/mirror/sync.ts:508-526`), with
`duplex: "half"`. Never buffered (AGENTS.md streaming rule).

**Step 5 — parse the report (report-status v0).**
Response `200`, `Content-Type: application/x-git-receive-pack-result`, body
pkt-lines (`gitprotocol-pack.txt` report-status; engine renderer
`renderStatus`, `protocol.ts:1640-1648`):

```
unpack ok\n        |  unpack <one-line error>\n
ok <ref>\n         |  ng <ref> [<error>]\n   (one per command)
<flush>
```

`unpack <error>` = the pack itself was rejected → whole push failed.
`ng <ref> fetch first` = the remote moved between advertisement and POST
(TOCTOU) → whole sync retried from Step 1 next cadence. `ng <ref>
non-fast-forward` (or server-specific text) = the remote refuses the update
(policy or hook) → recorded in `last_error`, not auto-recovered (§6.3).
Any `ng` fails the sync wholesale (upstream: git push exits non-zero on any
rejected ref, `repo.go:250-259` buckets `! [remote rejected]` into
`ErrPushRejected`), with the failed refs listed in `last_error` (capped).

### 2.3 Refset, force, prune

- **Refset (v1)**: `refs/heads/*` and `refs/tags/*` — the refspecs upstream
  *configures* (`mirror_push.go:37-40`), and the intersection of `--mirror`'s
  `refs/*` with what third-party remotes (GitHub et al.) actually accept
  (creating `refs/pull/*` on GitHub is rejected server-side, so strict
  `--mirror` parity would fail real targets). This is a deliberate divergence
  from `--mirror`'s literal `refs/*`; recorded here and in §8.1.
- **Force**: always (§2.2 step 2 — `old := remote tip`, never a fast-forward
  check). Upstream pushes with `Force: true` (`mirror_push.go:160`).
- **Prune**: deletes are **always on** within the pushed namespaces —
  `--mirror` implies prune and upstream has no toggle on `push_mirrors` (the
  pull direction's `enable_prune` column has no push counterpart in upstream's
  model, `pushmirror.go:20-32`). Divergence guard: an empty LOCAL repo deletes
  nothing — the sync skips entirely (§6.6; git `--mirror` from an empty repo
  would delete every remote ref, which we refuse to do silently).

### 2.4 Pack generation — reuse-vs-build verdict

**Verdict: REUSE the engine's pack generation, via a loopback `git-upload-pack`
composition. Zero vendored-engine changes.** A worker-side pack builder over
raw store reads is rejected (below). Engine-native alternatives exist if the
composition ever needs to get leaner (§8.2) — they would be NOTICE-recorded
adaptations, not v1 work.

**The audit.** Pushing needs a function `pack(closure(our tips) −
closure(remote's advertised oids)) → pack byte stream`. That is *precisely* the
fetch negotiation algebra with the roles renamed — the remote plays the
fetch client whose "haves" are its advertised oids:

| Need | Engine module (exists, byte-tested in production serving) |
|---|---|
| "objects the client already has" walk (commits reachable from haves + boundary tree closure, deliberately an under-approximation) | `excludedObjects(store, haves, clientShallows, wants)` — `packages/git-engine/src/git/protocol.ts:564-651` (module-private; composed below, not imported) |
| "objects to pack" closure walk | `collectPackOids(store, wants, excluded, commitLimit, descendThroughExcluded, expected)` — `protocol.ts:667-701` |
| pack byte emission, streaming, running SHA-1 | `PackWriter` (`header/object/rawFull/rawDelta/finish`) — `packages/git-engine/src/git/pack.ts:84-124` |
| stored-entry verbatim copy + ref-delta addressing (base ships in-pack only → the emitted pack is always self-contained) | the emission loop in `uploadPack`, `protocol.ts:940-1204` (sorting + `packs.lookup`/`packs.readRaw` from `packages/git-engine/src/git/packstore.ts:304,358`) |
| GC safety for R2-backed pack reads | the read-lease machinery — `openPlanLease`/`serveReadGate` (`protocol.ts:715-760`) over `planFetch` (`src/read-leases.ts`) |
| object graph reads | `GitStore` (`packages/git-engine/src/git/store.ts:98` — `get/has/typeAndSize/refs/resolveHead/loadReachable/reachableCacheValid`) |

All of the above is reachable **as-is** through the DO's `git-upload-pack`
HTTP surface: `POST /{owner}/{repo}.git/git-upload-pack` with a v0 body
`want <our tip> multi_ack_detailed side-band-64k no-progress agent=…` …
`have <remote advertised oid>` … `done` + flush — exactly the body
`buildV0FetchBody` already assembles (`gitclient.ts:393-407`). The DO-side
`uploadPack` answers with `ACK common… / ACK|NAK` + a sideband-64k pack
(`protocol.ts:860-891, 1089-1204`), where:

- `haves` = the REMOTE's advertised oids (tips + peeled targets, deduped,
  ≤ `MAX_HAVES` = 256, gitclient.ts:75 — truncation only inflates the pack,
  never corrupts it: the exclusion walk is designed to under-approximate);
- `wants` = our new tips (must be *our advertised* tips — they are, and
  `uploadPack`'s `advertisedOids` gate, `protocol.ts:813-819`, is satisfied);
- `no-progress` skips band 2; band 1 is demuxed to the raw pack by
  `demuxPackResponse` (`gitclient.ts:466-661`) — the pull direction already
  consumes exactly this response shape;
- the loopback call rides the trusted-internal composition
  (`engine.fetch` + `markGateCleared`, the `warmCell`/`runReceive` pattern of
  `src/services/mirror/sync.ts:611-637`).

The demuxed band-1 stream *is* the pack we POST to the remote (after the
command-section prefix, §2.2 step 4). Sideband frame + deframe across the
DO→Worker boundary is one cheap byte move per 32 KiB chunk
(`SIDEBAND_CHUNK`, `protocol.ts:28`). Free side effects: the full-clone
R2 cache warms itself on the loopback MISS path, and all lease/GC/bookkeeping
behavior is the production serving path's, not a new one.

**Why not build in the Worker** (the "thin client-side pack builder over store
reads"): the Worker has no `GitStore` — objects live behind the DO
(`lookupObjects` RPC rows give raw object payloads only, NOTICE.md 2026-10-24
repo.ts row). A Worker builder would (a) walk the graph through per-object RPCs,
(b) lose the stored-entry verbatim copy + ref-delta reuse (`packs.readRaw` /
`PackWriter.rawFull`/`rawDelta` need compressed-region reads the RPC surface
does not expose), (c) re-implement the exclusion walk's subtleties (date slop,
boundary tree closure) with no second implementation to test against, and
(d) run the CPU-heavy walk in the Worker's budget instead of the DO's. Strictly
worse on every axis. **This is the core reuse finding: nothing new needs to be
invented; the engine already serves both halves of the conversation.**

### 2.5 The client shell — what lands net-new

~350 LOC in `src/services/mirror/pushclient.ts`, mirroring gitclient.ts's
structure (the pull client's runner/parsers are reused, not duplicated where
they are service-agnostic):

- `fetchReceiveRefs(repoUrl, opts)` — Step 1 GET with the receive service URL +
  content type; reuses `runRequest`'s posture (redirect:manual, per-hop egress
  re-validation, 307/308-only for the eventual POST, abort timeout, strict
  content types — `gitclient.ts:711-763`) and `parseInfoRefsAdvert`
  (`gitclient.ts:247`) as-is; adds: `delete-refs` absence → deletes are
  planned as skipped-with-note (never sent), `object-format` ≠ sha1 → clean
  `SmartHttpError`.
- `planPushSync(advert, localRefs)` — Step 2 diff (§2.3 semantics), the mirror
  image of `planMirrorSync` (gitclient.ts:1046-1078): polarity inverted, prune
  always-on, HEAD excluded, refset filter `refs/heads/` + `refs/tags/`,
  refname validation on the names we would create/update.
- `buildReceivePackBody(commands)` — the command-section pkt-lines (caps on the
  first command, NUL-separated, then flush) as golden-bytes-exported builder.
- `pushPack(repoUrl, commands, packStream | null, opts)` — Step 4 POST
  (`prependStream` when a pack exists, bare section when not) + Step 5
  report parse. The report parser is the one sync.ts already carries
  (`parseReportStatus`, `sync.ts:573-601`) — that helper collapses into
  `pushclient.ts` (or a shared `pktline-util` module, the same collapse note
  sync.ts:52-57 already records for its receive helpers) so both consumers
  share one parser.
- Egress: `checkMirrorSource` (`gitclient.ts:926-968`) re-runs on every sync
  against the STORED url, and `runRequest` re-validates every redirect hop.

---

## 3. Data model

### 3.1 What migration 0023 landed

`push_mirrors` (`src/db/migrations/0023_fresh_captain_america.sql`; Drizzle
table `pushMirrors`, `src/db/schema.ts:2196-2242`):

| column | sync's use |
|---|---|
| `id`, `repo_id`, `remote_name`, `remote_address` | row identity + target URL (sanitized) |
| `sync_on_commit`, `interval_seconds` | producer eligibility (`interval_seconds != 0` → cron; `sync_on_commit` → commit hook) |
| `created_unix` | rendered only |
| `last_update_unix` | **last ATTEMPT time** (upstream semantics: set on success AND failure, `mirror_push.go:110`); NULL until first sync |
| `last_error` | sanitized failure text, `""` when clean (§4.4) |
| `credentials_username`, `credentials_ciphertext` | §5.1 |

### 3.2 What the sync needs that 0023 does not have

The scheduling claim (§4.2) needs a CAS column like the pull direction's
`repo_mirrors.sync_state`/`next_sync_at` (`schema.ts:1285-1295`) —
`last_update_unix` alone cannot both record "attempted at" and arbitrate
double-enqueue between the cron producer, the commit hook, and the API trigger.

**Migration list (one migration, next number `00XX`):**

```sql
ALTER TABLE `push_mirrors` ADD `sync_state` text DEFAULT 'idle' NOT NULL;
ALTER TABLE `push_mirrors` ADD `next_sync_at` integer DEFAULT 0 NOT NULL;  -- 0 = unscheduled
CREATE INDEX `push_mirrors_next_sync_idx` ON `push_mirrors` (`next_sync_at`);
```

plus a CHECK `sync_state IN ('idle','queued','syncing')` matching
`repo_mirrors_sync_state_check` (`schema.ts:1306`). Both columns are additive;
0023-era rows wake up as `idle`/unscheduled and the first cron sweep schedules
them. No change to any landed column; no change to the API wire shape.

The alternative (no migration; CAS on `last_update_unix := now` as the claim,
upstream's due arithmetic verbatim) is viable and listed as open question §8.3;
the SPEC prefers the explicit state machine because it is the landed,
queue-redelivery-proven pull pattern (claim `idle|queued → syncing`,
`sync.ts:233-241`) and keeps "in-flight" observable.

**RESOLVED (§9.3)**: the state-machine columns LANDED as migration
`0032_wealthy_siren.sql` (`sync_state` text default 'idle' with the
`push_mirrors_sync_state_check` CHECK, `next_sync_at` integer default 0, the
`push_mirrors_next_sync_idx` index — SQLite requires the create/copy/drop
table dance for the CHECK; all rows are preserved and the index set is
rebuilt). Drizzle table `pushMirrors` carries both columns.

**Stuck-syncing sweep (as-built, 833961d)**: both cron producers
(`enqueueDueMirrorSyncs` pull, `enqueueDuePushMirrorSyncs` push) run a
reclaim BEFORE the due-SELECT — a CAS `syncing → idle` on rows whose claim
age ≥ `SYNCING_SWEEP_AFTER_SEC` (15 min = the engine's receive-lease TTL,
`control-plane.ts:330`: no live sync can outlive it; a queue consumer also
cannot exceed its 15-min wall), then the same-tick due-SELECT re-enqueues
them (a claimed row's `next_sync_at` is still due — only settles advance
it). Push claims stamp `last_update_unix` at attempt start (upstream's
records-every-attempt posture, `mirror_push.go:110`); the sweep's NULL arm
reclaims stamp-less `syncing` rows unconditionally (pre-stamping wedges
cannot be mid-flight), healing pre-deploy wedged rows on the first cron
tick. Fresh claims (< TTL) are never touched — the busy-skip is their
guard. Motivation + adjudication: `docs/research/sqlite-locked-2026-10-26.md`
(the availability gap: a settle-step transient wedged the row forever —
claim required `idle|queued`, retries acked `busy`, no sweeper existed).

---

## 4. Scheduling and execution model

### 4.1 Producers (all funnel into one queue kind)

- **API trigger** (landed): `enqueuePushMirrorSyncs`
  (`src/api/services/push-mirrors.ts:429-449`) → `{kind: "push-mirror-sync",
  repoId, pushMirrorId}` per row.
- **Cron producer** (new arm in `scheduled`, `src/index.ts:133-135`):
  `SELECT … FROM push_mirrors JOIN repositories ON … WHERE interval_seconds !=
  0 AND next_sync_at <= now AND sync_state = 'idle' AND
  repositories.is_archived = false ORDER BY coalesce(last_update_unix, 0)
  LIMIT 50` — upstream `PushMirrorsIterate`'s WHERE/ORDER/LIMIT shape
  (`pushmirror.go:147-160`, including the archived filter and the
  `interval != 0` scheduler switch). CORRECTION over the draft WHERE below
  (§9.3): the draft's `next_sync_at != 0` conjunct contradicted §3.2's own
  "0023-era rows wake up as idle/unscheduled and the first cron sweep
  schedules them" — a never-synced row carries `next_sync_at = 0`, which must
  be DUE (`0 <= now`), exactly upstream's arithmetic where `interval != 0`
  (not the timestamp) is the on/off switch. Then CAS-claim each row
  `idle → queued` and `sendBatch` — the `enqueueDueMirrorSyncs` pattern
  (`sync.ts:836-868`) over the push table. The sub-hour cron's 30 s CPU
  budget (AGENTS.md) is safe: SELECT + enqueue only.
- **Commit hook** (new): in the entrypoint `onPush` path
  (`src/index.ts:39-44`), after the webhook fan-out, one SELECT
  `WHERE repo_id = ? AND sync_on_commit = true` (`pushmirror.go:140-145`
  parity) + per-row enqueue. Best-effort: an enqueue failure logs, never fails
  the push response (upstream's `AddPushMirrorToQueue` is fire-and-forget,
  `mirror_push.go:250-260`).

A claim (`idle|queued → queued`) at enqueue time plus a re-claim
(`queued → syncing`) in the consumer (§4.2) makes redelivery and producer races
harmless — the pull direction's exact two-step discipline
(`sync.ts:233-241, 851-860`).

### 4.2 The consumer arm

`handleRepoTasks` (`src/repos/purge.ts:138-177`) gains the
`isPushMirrorSyncMessage` arm before the malformed-drop ACK (today's
ACK-and-drop of the unknown kind, documented `push-mirrors.ts:45-50`, is
replaced by real work). Per message, `handlePushMirrorSync(env, {repoId,
pushMirrorId})` runs the §2 flow with the pull sync's shape:

1. load repo + mirror row (either gone → `skipped: "missing-row"`, ack);
   re-claim `queued|idle → syncing` (lost → `skipped: "busy"`, ack);
2. re-run the egress gate on the STORED url (§5.2); decrypt credentials (§5.1);
3. `fetchReceiveRefs` → `planPushSync` → commands;
4. when objects are needed: loopback `upload-pack` (haves = remote oids) →
   demux → `pushPack` (pack piped, never buffered); deletes-only → section-only
   POST; nothing to do → settle, ack;
5. settle (§4.4) → ack.

Queue posture is inherited: `repo-tasks` consumer
`max_batch_size 1, max_concurrency 1, max_retries 5` (`wrangler.jsonc` queues
block) — one serialized task lane; a throw retries the message, terminal
outcomes ack (§4.4).

### 4.3 Budgets and timeout posture

- **Wall vs CPU** (AGENTS.md): queue consumers get 15 min wall + `limits.cpu_ms`
  (300000 = 5 min, `wrangler.jsonc`). The Worker's share of the sync is framing
  and pipes (CPU≈free); the walk CPU is spent inside the RepoCell DO on the
  loopback upload-pack call, against the DO's own budget — the same split a
  served clone enjoys.
- **Per-request abort**: `AbortSignal.timeout` per leg, default 600 s
  (`DEFAULT_FETCH_TIMEOUT_MS`, gitclient.ts:79) — a stuck-stream backstop, not
  a transfer bound (HTTP wall time is unlimited while the client stays
  connected).
- **Streaming**: advertisement read capped (8 MiB, `ADVERT_MAX_BYTES`); the
  loopback pack demux enforces a counting cap (`demuxPackResponse` `maxBytes`);
  the outbound POST streams with `duplex: "half"`. A 1 GiB outbound default cap
  (`PACK_MAX_BYTES`, gitclient.ts:71) bounds pathological packs; exceeding it
  fails the sync into `last_error` (§6.9 discusses chunking).
- **Sizing note**: the engine's own receive cap is `MAX_PUSH_MB` (default
  512 MiB, `mod.ts:944,161`) — a reminder that REMOTE servers may reject large
  pushes independently; `ng`/unpack failures surface per §6.5.

### 4.4 Settle, retry, backoff

Terminal outcomes ack; only infrastructure failures (D1 down, DO errors) throw
→ queue retry (max 5, then the drop-with-log posture wrangler.jsonc documents).

- **Success**: `last_update_unix = now`, `sync_state = 'idle'`,
  `next_sync_at = interval_seconds > 0 ? now + interval_seconds : 0`,
  `last_error = ''` — all CAS'd on `sync_state = 'syncing'` so a delete racing
  the sync cannot resurrect the row (`settleMirrorSuccess` shape,
  `sync.ts:251-262`).
- **Failure**: `last_update_unix = now` (upstream records attempts,
  `mirror_push.go:110`), `sync_state = 'idle'`, `next_sync_at` left DUE
  (unchanged) so the next cron sweeps retry — the pull direction's backoff
  posture (`sync.ts:303-310`); `last_error` = sanitized text, truncated to
  2000 chars, credential-free (§5.1), rendered by the landed
  `toApiPushMirror.last_error` field. Upstream's retry posture is identical in
  spirit: failure only records text; the next interval retries
  (`SyncPushMirror` has no backoff state machine either).
- **No-op** (remote already identical): settle as success with zero commands —
  `last_update` still advances (upstream advances it on every sync attempt).

---

## 5. Security

### 5.1 Credentials (at rest, in memory, on the wire)

- **Storage** (landed): `credentials_ciphertext` = `base64( nonce[12] ||
  AES-256-GCM(authHeader) )`, key = `MIRROR_CREDENTIAL_KEY` (32-byte base64
  KEK), AAD `${row.id}:${repoId}` — the §4.2 envelope; the encrypt half lives
  in `addPushMirror` (`push-mirrors.ts:473-492`) and is byte-compatible with
  the pull channel's decrypt (`mirrorAuthHeader`, `sync.ts:445-466`). The push
  sync reuses that decryptor (factored to a shared module or imported) —
  wrong AAD (row swap) fails the sync cleanly; KEK absent while a ciphertext
  exists fails cleanly. This is the same at-rest precedent as the oauth2-apps
  wave's PBKDF2 secret sealing (one KEK, per-row AAD, never echoed).
- **Composition** (landed): `derivePushMirrorAuthHeader`
  (`push-mirrors.ts:223-230`) → `Basic base64(user:pass)` (RFC 7617); sent only
  over the https requests `checkMirrorSource` admits.
- **Never echoed**: the header value exists only in the consumer's memory for
  the sync's duration; error/log surfaces carry `sanitizeUrl`-ed URLs
  (`gitclient.ts:105-112`), matching upstream's
  `util.SanitizeErrorCredentialURLs` (`mirror_push.go:105`). The API renders
  `remote_address` sanitized (userinfo rejected at the gate anyway).
- **Rotation**: out of scope v1 (no PATCH on push mirrors landed; upstream
  re-creates the remote to change credentials). Open question §8.7.

### 5.2 SSRF posture (which remote URLs are permitted)

- **Registration gate** (landed): `checkPushMirrorTarget`
  (`push-mirrors.ts:190-213`) — https-only, no userinfo, control-character
  rejection, `MIRROR_ALLOWED_HOST_LIST` policy via `parseHostPolicy` +
  `checkMirrorSource` (401 "Permission denied" bucket). Upstream parity:
  `ParseRemoteAddr` + `IsMigrateURLAllowed` + `HandleRemoteAddressError`
  (`mirror.go:352-405` at the pin), with the documented divergence that
  http/git schemes are refused (cf-gitea is https-only, both directions).
- **Per-sync re-validation**: upstream re-checks every sync because the
  allow/block lists may have changed (`mirror_push.go:130-136`); our consumer
  re-runs `checkMirrorSource` on the STORED url before any byte moves (§4.2
  step 2) — the pull channel's identical discipline (`sync.ts:745-747`).
- **Redirect hardening**: `runRequest`'s manual-redirect loop re-validates every
  hop (scheme stays https, egress gate re-run, ≤ 5 hops, POST only on
  307/308) — the landed pull runner (`gitclient.ts:711-763`), reused as-is.
- **Port/class filters**: IP-literal classification (reserved always denied;
  loopback/RFC1918/link-local/CGNAT/ULA denied unless an explicit IP allow
  entry) and the `localhost`/`*.local`/`*.internal` hostname denial come from
  the shared webhook SSRF module via `checkMirrorSource`
  (`gitclient.ts:926-968`) — identical for both mirror directions; port ranges
  ride the policy entries.
- Workers-side residual (documented, accepted): fetch re-resolves DNS
  independently of any hostname gate — the TOCTOU is the same one the webhook
  and pull channels accept, mitigated by per-hop re-validation.

---

## 6. Edge cases, limits, failure modes

1. **Force-push semantics**: always-force (§2.2/§2.3). A local rewind lands as
   an update command with `old = remote tip`; the remote either accepts (mirror
   parity) or `ng`s on policy.
2. **Ref deletions (prune)**: always-on within `refs/heads/*` + `refs/tags/*`
   (§2.3). Delete commands require the remote's advertised `delete-refs`
   capability (gitprotocol-pack.txt); without it, deletes are dropped from the
   plan and the shortfall is noted in the sync result (never silently
   pretended). Deletes-only syncs send no packfile (§2.2 step 3).
3. **Diverged remote** (remote rewritten/advanced beyond us, or a remote-side
   policy refuses): `ng <ref> <server text>` → sync fails, `last_error` carries
   the ref + text (capped), retried at the next cadence. No automatic recovery
   — a genuinely diverged mirror target needs admin action, matching upstream
   (git push fails; the error lands in `last_error`, `mirror_push.go:104-108`).
4. **TOCTOU advertisement→POST** (remote moved in between): `ng <ref> fetch
   first` (our engine's text, `protocol.ts:1600`) or server equivalent → whole
   sync fails and the next cadence re-advertises. Not retried inline (the
   cadence is the retry).
5. **Partial pack failures**: `unpack <error>` (server-side pack rejection) or
   any `ng` → sync failed; per-command outcomes from report-status are joined
   into `last_error` (first few refs + count). receive-pack applies commands
   independently — a partial apply (some refs moved, some `ng`) is recorded as
   a failed sync; the next sync's fresh advertisement sees the mixed state and
   issues only the missing updates (self-healing by CAS).
6. **Empty local repo**: skip the sync entirely (no advertisement fetch, no
   deletes) and settle success — never let a mirror's first sync before the
   first push wipe the target (§2.3 divergence guard; upstream's git `--mirror`
   would delete, which we refuse to replicate silently).
7. **Empty remote / remote advertises `capabilities^{}`**: every local ref is a
   create; haves = [] → the loopback upload-pack takes the full-clone path
   (R2-cached when warm, `protocol.ts:928-965`).
8. **`object-format=sha256` remote**: clean failure at advertisement parse;
   `last_error` says the target is sha256. The engine store is SHA-1 only.
9. **Oversized pushes**: outbound cap default 1 GiB (§4.3) → sync fails with a
   clear error. Escape hatch (not v1): chunk commands into ref-batches, each
   POST self-contained (every batch's pack covers its own closure — §2.2's
   haves-exclusion makes batches independent by construction). Sequencing note
   for that future: delete commands can ride any batch; batch order is
   irrelevant for correctness because each update's CAS old-value is the
   remote's tip at advertisement time — but a batched design must re-advertise
   between batches. Open question §8.6.
10. **Concurrent syncs of one mirror** (API trigger + cron + commit hook):
    sync_state CAS — exactly one wins `queued/syncing → syncing`; losers ack as
    `skipped: "busy"`.
11. **Repo or mirror row deleted mid-queue**: `skipped: "missing-row"`, ack.
12. **Archived repo**: the cron producer's join excludes it (upstream
    `is_archived = false`, `pushmirror.go:154`); API-triggered syncs of
    archived repos are already refused by `assertNotArchived` (423).
13. **Mirror target rejects `delete-refs`-less servers**: §6.2 — dropped
    deletes are surfaced, the create/update half still lands.
14. **Zero-object pack** (tips exist remotely, only refs move — e.g. a new
    branch pointing at an existing commit): the loopback upload-pack emits a
    valid 0-object pack (header + trailer ≥ 32 bytes, the engine's own minimum
    convention); it is sent normally — legal per gitprotocol-pack.
15. **Wiki / LFS**: §1.3 — out, with the upstream citations recorded there.

---

## 7. Testing plan

All in `@cloudflare/vitest-pool-workers` (real D1/DO/R2 bindings) unless noted.

**The round-trip oracle (feasibility: high — every piece exists).** The
outbound client's `fetchImpl` seam (`FetchImpl`, gitclient.ts:94; the sync
tests already stub exactly this, `sync.test.ts:121-133`) is pointed at the
WORKER'S OWN ENGINE: the test constructs `engine.fetch` exactly as
`src/index.ts:39-44` does (or reuses the entry module's shape) over the test
env, and the seam rewrites `https://mirror.test/<seeded>.git/...` requests into
the trusted-internal loopback form (`markGateCleared`, the
`sync.ts:528-546` composition). One test then exercises the FULL protocol with
zero mocks beyond transport: our client reads the engine's real receive-pack
advertisement (`advertisement`, protocol.ts:59-92), loopback upload-pack
generates a real pack from real R2-backed packs, and the POST lands in the
engine's real receive server (`receivePack`, `mod.ts:930-…`: `parsePushRequest`
:638 → `stagePack` :717 → scan/finalize) into a SECOND seeded repo. Assertions:
second repo's `listRefs()` equals the first's; report-status all-ok;
`last_update_unix`/`last_error` settled; a second sync is a no-op
(`next_sync_at` advanced, zero commands). Deletes: delete a local ref, sync,
assert the remote ref is gone (engine advertises `delete-refs`,
protocol.ts:73). Force: rewind a branch, sync, assert the remote tip rewound.

**Unit tests:**

- `planPushSync`: create/update/delete table over a synthetic receive advert
  (peeled `^{}` lines, `capabilities^{}` empty shape), refset filter
  (`refs/pull/x` never planned), HEAD excluded, prune-on-deletes, sha256 advert
  rejected, missing `delete-refs` → deletes dropped with note.
- `buildReceivePackBody` golden bytes: caps on the first command (NUL position),
  flush, deletes-only = section-only request.
- Report parse: `unpack ok` + all-ok; `unpack <err>`; mixed `ok`/`ng` with
  messages; truncated body → `SmartHttpError` (reuses the strict hex4 parser
  rules — the engine's `PktParser` discipline).
- Credentials: decrypt → Authorization composition; wrong AAD fails; KEK absent
  fails cleanly; the value never appears in any error string (string-scan
  assertion over the thrown errors).
- Egress: stored-url re-validation on every sync; redirect-to-internal
  aborted (stub server); https downgrade refused; port-range policy honored.
- State machine: due-select + enqueue CAS (no double-enqueue: cron racing the
  API trigger); `busy` skip on lost claim; failure leaves `next_sync_at` due
  with sanitized `last_error`; success schedules `now + interval`;
  `interval_seconds = 0` never cron-scheduled but commit-hook eligible;
  sync-on-commit enqueue after an `onPush` event; archived repo excluded from
  the cron sweep.
- Failure injection via a stub fetch (`stubFetch` pattern,
  `sync.test.ts:121-133`): advertisement 401/500, non-git content type, `ng
  non-fast-forward`, `ng fetch first`, `unpack` error, redirect budget, sha256
  advert, empty local repo skip.

**E2e (follow-up, not v1 CI):** a loopback real-git receive target
(`git receive-pack --stateless-rpc` behind a tiny HTTP harness, the
SPEC-0009 §5 fixture pattern inverted) to validate against stock git's
report-status text set. The in-worker round trip above is the CI gate; the
real-git leg validates server-text tolerance only.

---

## 8. Open questions for implementation

> ALL RESOLVED — §9 records each decision as landed. §8 is kept verbatim as
> the decision trail.

1. **Refset**: keep v1 `refs/heads/*` + `refs/tags/*` (§2.3, recommended) or
   pursue literal `--mirror` `refs/*` parity (breaks GitHub-type targets for
   `refs/pull/*`)? Decision recorded in the SPEC header at implementation.
2. **Engine-native pack route** (only if profiling demands): export a
   `packForPush(store, {wants, haves}) → ReadableStream` from `protocol.ts`
   (composing the private `excludedObjects`/`collectPackOids`/`PackWriter`
   with the lease machinery) behind a NOTICE-recorded internal DO route,
   eliminating the sideband frame/deframe hop. v1 ships the loopback
   composition (zero engine changes); revisit only on measured cost.
3. **Scheduling columns vs `last_update_unix` CAS**: the SPEC prefers the
   `sync_state`/`next_sync_at` migration (§3.2). The migration-free variant
   (claim by `last_update_unix := now`, upstream's exact due arithmetic) is the
   fallback if a migration is undesirable at landing time — it conflates
   in-flight visibility but matches upstream one-for-one.
4. **`last_error` shape for partial applies**: single-line join (current plan)
   vs per-ref structured column (upstream keeps a single text column — parity
   says stay single-line).
5. **Sync-on-commit enqueue path**: ride the entrypoint `onPush` hook
   (`src/index.ts:43`, needs orchestrator wiring — shared file) vs a
   `queue.send` from `handleUserPushEvent`'s own module. Owner decision at
   implementation; behavior identical.
6. **Ref-batch chunking**: land the §6.9 escape hatch now or after a real
   >1 GiB mirror appears? Default: wait for evidence.
7. **Credential rotation** (PATCH or re-PUT semantics): upstream has no API
   for it either (re-create the mirror); confirm out-of-scope with the API
   batch owner.
8. **Wiki mirroring** (upstream's second `performPush`): defer until wiki repos
   have a stable lifecycle story (`specs/wiki.md`).
9. **`report-status-v2`**: v1 requests plain `report-status` (universal);
   `report-status-v2` adds option-rich ref results we do not consume. Revisit
   only if a major target stops advertising v0 report-status (none known).

---

## 9. Resolutions (as landed, 2026-10-26)

The landing: `src/services/mirror/pushclient.ts` (the §2.5 client shell),
`src/services/mirror/push-sync.ts` (`handlePushMirrorSync` + the two
producers + the `isPushMirrorSyncMessage` queue guard), the shared-runner
extensions in `gitclient.ts` (stream-body POSTs, the `Accept` header, the
`git-protocol` offer made omittable — the pull channel's behavior is
byte-identical), and migration 0032. Zero vendored-engine changes, as
verdicted in §2.4.

1. **Refset (§8.1)** — v1 `refs/heads/*` + `refs/tags/*` (the SPEC's own
   recommendation, §2.3). `inPushRefset` gates BOTH the push side (creates)
   and the prune side (deletes); HEAD and `refs/pull/*` are never planned and
   never deleted. Out-of-refset advertised oids still ride the loopback
   fetch's haves (the remote truly holds those objects).
2. **Pack route (§8.2)** — the loopback `git-upload-pack` composition
   shipped; the engine-native `packForPush` export stays deferred until a
   measured cost justifies a NOTICE-recorded engine adaptation. The oracle
   tests exercise the real sideband frame/deframe path end to end.
3. **Scheduling (§8.3)** — the state-machine migration LANDED (0032, §3.2).
   One correction to the draft WHERE: the scheduler's switch is
   `interval_seconds != 0` (upstream's `interval != 0`); `next_sync_at = 0`
   rows are DUE, not excluded (they are the never-synced 0023-era wake-up and
   every fresh registration) — §4.1 as amended. The draft's
   `next_sync_at != 0` conjunct would have starved exactly the rows §3.2
   promised to schedule.
4. **`last_error` shape (§8.4)** — single-line join (`describeReportFailure`:
   first 5 failed refs + messages, then a counted tail), truncated to 2000 by
   the failure settle. Upstream parity (one text column).
5. **Sync-on-commit path (§8.5)** — the producer is LANDED as
   `enqueuePushMirrorSyncsOnCommit(env, repoName)` (best-effort, catches its
   own, never fails the push), but the entrypoint wiring is ORCHESTRATOR
   scope: `src/index.ts` is a shared file outside this wave's ownership. The
   exact three-line snippet rides `push-sync.ts`'s module header (the
   `onPush` mount at the `handleUserPushEvent` call — `src/index.ts:43`, plus
   the `scheduled` producer arm and the `purge.ts` consumer arm). Behavior
   until wired: the sync API trigger and the cron producer (once wired) drive
   the lane; commit hooks enqueue nothing.
6. **Chunking (§8.6)** — deferred (the §1.3 default); the 1 GiB outbound cap
   (`PACK_MAX_BYTES`) fails oversized syncs into `last_error`.
7. **Rotation (§8.7)** — out of scope v1; no PATCH landed, upstream re-creates
   the remote.
8. **Wiki (§8.8)** — deferred (SPEC `wiki.md` lifecycle).
9. **report-status-v2 (§8.9)** — plain `report-status` requested
   (`RECEIVE_PACK_CAPS`), no side-band on the result (plain pkt-line report),
   v0 advertisement only (the `git-protocol: version=2` offer header is
   omitted on the receive legs — receive-pack is v0-only).

**Testing as landed (§7)**: `pushclient.test.ts` (the decision tables, golden
command-section bytes, shared report parser, advertisement refusals) and
`push-sync.test.ts` (the §7 round-trip oracle — the fetchImpl seam rewrites
`https://mirror.test/...` onto a real second engine mount, advertisement →
loopback upload-pack → real receive into a second seeded repo, refs-match,
no-op resync, prune delete with a deletes-only no-pack POST, force rewind via
a 0-object pack — plus the mini in-test receive-pack server's failure arms:
401, sealed-Basic auth, `ng non-fast-forward`, `unpack` error, diverged-remote
command capture with `old := remote tip`, empty-local skip, busy/missing-row,
egress denial — and the state battery: cron due-select + CAS claims with
archived/interval-0/future exclusions, commit-hook eligibility, failure
leaving `next_sync_at` due).

---

## Sources (protocol claims)

- git `Documentation/gitprotocol-http.txt` — smart client discovery
  (`GET $GIT_URL/info/refs?service=$servicename`), the four content types, and
  the POST body = pkt-lines + packfile composition.
- git `Documentation/gitprotocol-pack.txt` — v0 ref advertisement (first-line
  capabilities, `^{}` peels, zero-id `capabilities^{}`); update-command grammar
  with per-ref `old` CAS; "The packfile MUST NOT be sent if the only command
  used is `delete`"; capability list (`delete-refs`, `report-status`,
  `side-band-64k`, `agent`, `object-format`); report-status `unpack`/`ok`/`ng`
  grammar.
- git `Documentation/gitprotocol-v2.txt` — protocol v2 defines ls-refs/fetch
  only; receive-pack remains v0 (push discovery is v0-only).
- git-push(1) — `--mirror` (all refs under `refs/`, deletes non-local refs,
  force implied) and `--force` (client-side permission to send non-fast-forward
  updates; not a wire concept).
- Cross-checked against the engine's own implementations of the same documents:
  `packages/git-engine/src/git/protocol.ts` (`advertisement`, `renderStatus`,
  `commitPush` CAS) and `packages/git-engine/src/mod.ts` `receivePack`.

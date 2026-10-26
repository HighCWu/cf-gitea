# The REDEPLOY18 `SQLITE_LOCKED` tail records — source analysis, repro, classification

Wave-48 diagnosis unit (`wave-sqlite-locked`), 2026-10-26. Subject: the 16
`database table is locked: SQLITE_LOCKED` exception records in REDEPLOY18's
wrangler tail window (12:19–13:22 UTC, `docs/design/p0-evidence.md` REDEPLOY18
block, OPEN issue 1) — "no request record attached, no probe impact observed".
Diagnosis only: no code was changed. Scratch repro rig lived in `/tmp`
(shredded after the run; every command and result below is from that run).

## 1. Source hunt — where SQLITE_LOCKED can surface in this stack

The message text itself is the first discriminator. SQLite's `errmsg` for
`SQLITE_LOCKED` is literally "database table is locked"; workerd formats
SQLite-layer errors as `<errmsg>: <CODE>` — proven on OUR pinned runtime by the
repro (§3), where a deliberate constraint violation printed exactly
`UNIQUE constraint failed: schema_migrations.id: SQLITE_CONSTRAINT (extended:
SQLITE_CONSTRAINT_PRIMARYKEY)` — same `<errmsg>: <CODE>` shape. Two layers can
emit it:

### 1.1 Our Durable Objects' SQLite (packages/git-engine — the likely source)

Both DO classes are SQLite-backed (`wrangler.jsonc` migrations tag v1,
`new_sqlite_classes: ["RepoCell", "Registry"]`). `RepoCell` touches
`ctx.storage.sql` through `GitStore`/`PackStore` (objects, chunks, refs, meta,
leases, pack_catalog/pack_objects/pack_data, reachable, peeled) and the KV API
(meta via `storage.get/put`-shaped rows? no — meta is a SQL table; the KV API is
used for alarms only). `Registry` has one `repos` table. Key call-discipline
facts (read, not changed):

- Every `sql.exec` in the engine is drained **synchronously** — `.toArray()` or
  `.one()` (`git/store.ts` throughout, `git/packstore.ts`, `registry.ts`). No
  cursor is held across an `await`.
- The ONE discarded cursor in the codebase is `tableExists()`
  (`git/migrations.ts:389-396`): `sql.exec("SELECT 1 FROM <name> LIMIT 1")`
  with the return value dropped. It runs in the GitStore/Registry constructors
  (journal probe + `classifyRepoState`), i.e. at every cold DO start.
  `SqlStorageCursor` has **no `close()`** in the pinned
  `@cloudflare/workers-types` 5.20261025.1 surface (`next/toArray/one/raw/
  rowsRead/rowsWritten` only), so the only releases are full drain or GC.
- Concurrency inside one DO: all SQLite ops are synchronous and workerd
  serializes them per connection; events interleave only at non-storage awaits
  (R2/fetch). The request-less runners are:
  - **`RepoCell.alarm()`** (`repo.ts:380-432`): lease-expiry sweep → gc branch →
    compaction → gc pass. The three work calls are try/catch-wrapped and log
    (`lease sweep failed` / `gc failed` / `compaction failed`), but the
    bookkeeping AROUND them is uncaught: `getMeta("gc-pending")`,
    `setMeta("gc-pending","0")`, `bindR2()` (getMeta/setMeta),
    `packs.activePackCount()`, `getMeta/setMeta` of the `*_wanted_at` stamps.
    Any SQLite-layer error there throws out of the alarm.
  - **DO RPCs** (`beginReceive`/`finalizeReceive`/`putIndexRows`/`listRefs`/…,
    `RepoCell`, and `Registry.upsert/get/list`): synchronous SQLite inside;
    R2 awaits between.
- Alarms are armed CONSTANTLY on the push paths: `beginReceive` sets the
  lease-expiry alarm (`control-plane.ts:503`, TTL 15 min → +1 s),
  `finalizeReceive` arms a +5 min GC alarm on every committed ref change
  (`control-plane.ts:765`), and the alarm re-arms itself every 30 s while
  GC/compaction work is pending (`GC_RETRY_MS`/`COMPACTION_RETRY_MS` = 30 s).
  A 63-minute window with dozens of probe pushes carries **hundreds of
  request-less alarm invocations** — the largest request-less population by far.

### 1.2 D1 (apps/worker metadata DB — the alternative source)

D1 is implemented on SQLite-backed DOs server-side, so its internal SQLite can
in principle produce the same text. Our D1 write surface, all through Drizzle:

- **Request-less writers** (the "no request attached" candidates):
  - cron `*/10` `scheduled` (`src/index.ts:147-152`): `enqueueDueMirrorSyncs`
    (SELECT due `repo_mirrors` + per-row CAS `idle→queued` +
    `sendBatch`) and the push-mirror twin (`services/mirror/sync.ts:806-838`,
    `services/mirror/push-sync.ts:464`).
  - queue consumers (`src/index.ts:159-167`): `repo-tasks` =
    delete-purge / fork replication / pull- and push-mirror syncs with the
    claim/settle UPDATE pairs (`sync.ts:235-243, 253-272, 307-312`;
    `push-sync.ts:191-232`); `webhook-delivery`'s
    `recordDeliveryOutcome` two-arm batch (`webhooks/consumer.ts:537`).
- **Request writers**: the counters+state batches (e.g. issue/PR creates close
  on `repositories` counter columns "in the same D1 batch", `db/schema.ts:55`),
  star/org/projects batches, session/PAT writes, `onPush`'s waitUntil producers
  (`enqueuePushMirrorSyncsOnCommit`, `handleUserPushEvent`).

**The D1 signature does not match the evidence.** Production D1 write
contention surfaces as `Error: D1_ERROR: SQLITE_BUSY: database is locked`
(documented postmortem of a ~200 req/s D1 write-lock incident,
tanstackship.com/blog/postmortem-d1-write-lock): different SQLite code
(SQLITE_BUSY, "database is locked"), and the `D1_ERROR` marker inside the
message. Miniflare's D1 object — the same error-passthrough shape — rethrows
with `error.name = "D1_ERROR"` (`miniflare/dist/src/workers/d1/entry.worker.js:78,
128`). Wrangler tail prints `name: message` (`wrangler-dist/cli.js:309537-309541`),
so a D1-sourced record reads `D1_ERROR: …` / `Error: D1_ERROR: …`. The evidence
records read `database table is locked: SQLITE_LOCKED` — the bare,
un-prefixed workerd SQLite format, i.e. **an error thrown inside our own
script's DO SQLite, not through the D1 binding**. Caveat, stated honestly: the
raw tail JSON was shredded per the window's hygiene rules, so the `name` field
cannot be re-read today; the message format is the surviving discriminator.

### 1.3 Why "no request attached" — wrangler's event typing (cited)

`wrangler tail` (4.152, `wrangler-dist/cli.js` ~309452-309541) branches on the
event object: fetch events carry `event.request` (and get the
`METHOD /url - outcome` line); **scheduled (`cron`), queue (`queue`),
RPC (`entrypoint.rpcMethod`), alarm (`scheduledTime` without `cron`), and email
events carry NO `request`** — they render as `Scheduled … @ time`, `Queue … `,
`{entrypoint}.{rpcMethod} …`, `Alarm @ time - outcome`. Exception records print
as `name: message` below the event line regardless. So "no request record
attached (unattributed to any URL)" is exactly the signature of an exception
raised in one of: the **DO alarm** (our biggest request-less population — §1.1),
the **cron scheduled handler**, a **queue consumer invocation**, or a **DO RPC
invocation**. It cannot distinguish further on its own — but combined with §1.2
(error shape) the alarm is the overwhelming favorite, with cron/consumer D1
calls second.

## 2. The plausible contention shapes, and what the code says about each

- **(a) cron producer racing a push settle's D1 batch**: both are single-statement
  Drizzle writes on DIFFERENT tables (`repo_mirrors`/`push_mirrors` vs the
  counters-bearing tables), and D1 serializes database-level writes (the
  documented contention failure is `SQLITE_BUSY`, §1.2). If this raced badly
  enough to error, the signature would be D1_ERROR/SQLITE_BUSY — not what the
  tail showed.
- **(b) two DO writes on one cell** (the e2e corpus's shapes —
  `packages/git-engine/e2e/check-fault-matrix.mjs` rows 1-3, check-read-leases,
  check-gc §7.1): the engine serializes via the receive lease (a second
  beginReceive busy-waits 503 Retry-After, `control-plane.ts:331,467`), the
  compaction/gc leases, `blockConcurrencyWhile` around packs-resetting GC
  (`repo.ts:637-643`), and workerd's single-connection SQLite. SPEC-0011's
  claim ("renewal and GC eligibility evaluate in the same serialized control"
  plane, `specs/0011-compaction-gc.md:82`) **holds on the paths that threw**:
  everything SQLite-side is synchronous and mutually serialized by the runtime;
  the only inter-event window is an R2 await, over which the engine holds no
  open cursor.
- **(c) the D1 batch arms colliding with a concurrent counter write**: same as
  (a) — a possible SQLITE_BUSY producer under load, not the observed
  SQLITE_LOCKED shape.

## 3. Repro — honest result: NOT reproducible locally; closest shapes recorded

Rig: `/tmp/sqllock-repro`, the workspace's own pinned runtime — wrangler
4.152.0 + miniflare 5.20261019.2-beta workerd, `compatibility_date
2026-10-19`, a SQLite-backed DO (`new_sqlite_classes`), driven over HTTP. Nine
DO-SQLite shapes; six D1 shapes (`d1_databases` binding, local D1). Results:

| Shape (engine pattern it mirrors) | Result on pinned runtime |
|---|---|
| `tableExists`-style discarded `LIMIT 1` cursor, then same-table INSERT (migrations.ts:389 → recordApplied) | **ok** — no lock retained; repeated ×300 leak/write pairs: ok (the only failure was the rig's own seeded UNIQUE duplicate, printed in workerd's `<errmsg>: <CODE>` format) |
| Same leak, write inside `transactionSync` (the real recordApplied path) | ok |
| Partially-iterated cursor across an `await`, then same-table write | ok (`rest=4` — snapshot drifted, no lock error) |
| Open cursor + KV `storage.put` (KV lives in `__cf_kv` of the SAME SQLite DB) | ok (rig then hit `cur.close is not a function` — no `close()` exists in this runtime, matching the types) |
| Open cursor + `setAlarm` / open cursor + `transactionSync` write | ok |
| Leaked cursor from event N, same-table write in event N+1 (×300) | ok |
| Two interleaved events on one DO (timer-yield vs write) | ok, ok |
| Drained-cursor control | ok |
| D1: concurrent `batch` × `batch` same table / batch × single write / different tables / `RETURNING` arm + write arm in ONE batch / SELECT arm + write arm / 8 overlapping 2-arm batches | ALL ok — local D1 serializes completely |

Conclusion of the repro: **on the pinned runtime, none of our stack's call
shapes — including the engine's one leaked cursor — can self-produce
`SQLITE_LOCKED`.** DO SQLite single-connection serialization plus synchronous
drain-everywhere makes a self-inflicted table lock unreachable, and local D1
single-node serialization hides any multi-isolate D1 contention by
construction. The remaining producers are production-runtime behaviors this
rig cannot host:

1. **Platform-side DO-internal SQLite errors** surfacing through request-less
   handlers. The exact string is documented as a production DO incident class:
   the Cloudflare Developers Discord thread "Anyone else seeing Durable Object
   internal errors right now?" (Aug 2026, mirror answeroverflow.com/m/1529160332348756089)
   discusses `database table is locked: SQLITE_LOCKED` as a DO-internal error
   severe enough to make DOs unusable transiently. This fits every observed
   property: request-less (alarm events), zero probe impact (probes' own
   requests were healthy; the errors landed in background sweeps/cron/consumer
   invocations), and the un-prefixed workerd error shape.
2. A production-D1-internal episode remains possible ONLY if the shredded
   records' `name` field was `D1_ERROR` — considered unlikely per §1.2.

## 4. Classification — benign-retry, with ONE real (unrelated-to-16) gap found

**The 16 records: benign-retry.** Verified on the paths that could have thrown:

- **Alarm path (favorites):** the three work consumers are caught and logged;
  the design is stamp-and-reconverge — `gc-pending` is cleared before the work
  ("at-most-once, so a throwing sweep can't trigger a retry storm",
  `repo.ts:405`), `*_wanted_at` stamps persist until a pass reports
  convergence, and a thrown alarm leaves the stamps SET, so the next push or
  re-armed alarm retries. The lease sweep is idempotent and also runs lazily at
  every beginReceive. **SPEC-0011's single-writer claim holds**: no lost write
  is reachable — a thrown alarm can delay GC/compaction/lease-reclaim, never
  skip it.
- **Cron/queue D1 path:** a thrown scheduled handler just fails that tick (the
  next 10-minute tick retries); mirror-sync messages retry (max_retries 5) and
  `handleMirrorSync` "re-checks every state" on redelivery (sync.ts:803);
  webhook deliveries redeliver/DLQ only on persist failure. No lost writes.
- **The one REAL gap this diagnosis found** (not the producer of the 16, but
  the reason this class is not fully ignore-able): a mirror row wedged in
  `syncing`. Sequence: claim CASes `idle→syncing` (`sync.ts:235-243`, push twin
  `push-sync.ts:191-199`) → a D1-layer error throws at the settle step (or the
  consumer isolate dies mid-sync) → the message retries → the retry's claim
  requires `idle|queued` (push: `ne(syncState,"syncing")`) → `skipped:"busy"` →
  **acked** (`repos/purge.ts:160-180`) → the row stays `syncing` forever: the
  cron SELECT only picks `idle` (`sync.ts:816`) and **no syncing-timeout
  sweeper exists** in either direction. One transient error at exactly that
  step permanently (silently) disables that mirror's sync. Not hit this window
  (the mirror battery settled clean), and it is an availability gap, not a lost
  write.

## 5. Recommended posture

**Ignore-with-filter for the 16 themselves; one small fix brief + one
observability rule.**

1. Do NOT chase the 16 as an app bug: local evidence (§3) rules out our call
   discipline; the shape points at platform-side DO SQLite errors absorbed by
   the stamp/lease/retry design (§4). Expected steady-state count: zero — a
   RECURRING pattern (e.g. one repo's alarm loop failing every 30 s, which the
   `*_RETRY_MS` re-arm would produce) would change this verdict; watch for it.
2. Next tail session, capture `--format json` (or keep the raw ndjson): the
   `event` member names the invocation kind (alarm/queue/scheduled/rpc) and
   `exceptions[].name` settles D1-vs-DO in one glance (`D1_ERROR` = D1
   internals; `Error` = DO SQLite). Shredding the raw records cost this
   diagnosis the last mile of attribution.
3. Fix brief (small, when a wave picks it up): a `syncing`-timeout sweep —
   both cron producers (or the consumers' claim) additionally reclaim rows
   whose `sync_state='syncing'` AND `updated_at`/`last_update_unix` older than
   ~15 min (the receive lease's own TTL) back to `idle`, so a crashed/errored
   sync self-heals instead of wedging. Symmetric for `repo_mirrors` and
   `push_mirrors`.
4. Optional hardening (defense-in-depth for request-less noise): wrap the
   alarm's uncaught bookkeeping (`getMeta/setMeta/activePackCount/bindR2`
   around the three consumers, `repo.ts:393-431`) in the same catch-log-rearm
   the work calls already get, so a platform-side lock prints a contextual
   line instead of a bare exception record.
5. `observability.traces` is enabled — if the episode recurs, Workers Logs can
   attribute invocations after the fact without a tail session.

## Sources

- Cloudflare DO SQLite storage API (KV in `__cf_kv` of the same DB; cursors
  have no snapshot isolation across `await`; input gates):
  https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- workers-sdk #15162 — exact `database table is locked: SQLITE_LOCKED` string
  on local D1 (serial, local-only bug; remote succeeds):
  https://github.com/cloudflare/workers-sdk/issues/15162
- Production D1 write-contention signature `Error: D1_ERROR: SQLITE_BUSY:
  database is locked` at ~200 req/s:
  https://tanstackship.com/blog/postmortem-d1-write-lock
- Production DO internal `database table is locked: SQLITE_LOCKED` reports
  (Cloudflare Developers Discord, Aug 2026):
  https://www.answeroverflow.com/m/1529160332348756089
- SQLite `SQLITE_LOCKED` ("database table is locked") vs `SQLITE_BUSY`
  semantics: https://www.sqlite.org/rescode.html
- In-repo: `packages/git-engine/src/repo.ts` (alarm 380-432, gc 637-643),
  `packages/git-engine/src/control-plane.ts` (lease TTL 330/498-505, stamps
  752-767), `packages/git-engine/src/git/store.ts` + `git/packstore.ts` +
  `registry.ts` (drain discipline), `git/migrations.ts:389-396` (the one
  leaked cursor), `apps/worker/src/index.ts` (scheduled/queue), `apps/worker/
  src/services/mirror/sync.ts` + `push-sync.ts` (claim/settle CAS),
  `apps/worker/src/repos/purge.ts:160-180` (ack/retry), `apps/worker/src/
  webhooks/consumer.ts:537` (delivery batch), `apps/worker/src/db/schema.ts:55`
  (counters-in-batch), `specs/0011-compaction-gc.md` (single-writer claim,
  fault matrix), `packages/git-engine/e2e/check-fault-matrix.mjs` (concurrency
  corpus), `docs/design/p0-evidence.md` REDEPLOY18 block (the evidence).
- Local runtime pins the repro: wrangler 4.152.0 / miniflare
  5.20261019.2-beta / workers-types 5.20261025.1 (`SqlStorageCursor` has no
  `close()`).

*(Diagnosis unit — no code, config, or evidence files touched; this report is
the unit's sole write.)*

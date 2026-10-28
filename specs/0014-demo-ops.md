# SPEC-0014: Demo operations — DEMO_MODE, the 72 h demo sweep, and the reference instance posture

Status: **accepted — ratified 2026-10-28** (orchestrator review passed with one
binding amendment: OQ-1 is RESOLVED by convergence — the registration surface is
the `ALLOW_SIGNUP`-gated signup being landed by the first-run-bootstrap wave, ONE
surface for self-host and demo alike; the demo enables the var, self-host
defaults keep it off. The `/register` route below names that surface. OQ-2 is
ratified as recommended — the hourly cron entry ships in the example config with
the gate comment; a no-op hourly invocation on default deployments is the
cheaper failure than a hand-maintained demo delta) ·
Date: 2026-10-28 · Fills the reference-demo posture for the deployed instance at
`cf-gitea-demo.aiapp.run` — display-purpose only, modeled on Gitea's own demo at
[https://demo.gitea.com](https://demo.gitea.com) (periodically cleaned, not a
production service — that instance is the pattern this SPEC operationalizes; the
practice is an ops convention upstream, not in-tree code).
Depends on: SPEC-0003 §2.5.5 (the delete cascade the sweep drives), SPEC-0009 §2.6
(the cron → queue producer pattern the sweep copies), SPEC-0005 §3.6 (the webhook
DLQ precedent the M0 prerequisite ports), SPEC-0002 (site-admin identity for the
exemption check).
Owns: the `DEMO_MODE` environment contract (§2), the repo-tasks dead-letter queue +
its handler (§3.0 — **the blocking M0 prerequisite**), the `{kind: "demo-sweep"}`
queue shape + the hourly producer + the consumer arm (§3), the demo signup arm, the
demo UI banner branch (§4), the in-app demo quotas (§4.3), and the demo ops runbook
(WAF rules + DLQ redrive, §4.1/§3.0).

Upstream findings are against the vendored submodule (`gitea/`, read-only, pin
`fc4936884584` — the same pin every 0012/0013-era citation uses). Landed-code
findings are against `apps/worker/**` + `packages/git-engine/**` as of 2026-10-28.

## 1. Problem and scope

cf-gitea runs a public reference demo instance at `cf-gitea-demo.aiapp.run`. Its
purpose is display: let a visitor push a repo, open an issue, click the UI — and
trust that what they see is a live instance, not screenshots. Left unattended, a
public writable Gitea accumulates garbage forever: throwaway repos, multi-GiB
pushes, abandoned accounts. Gitea's own demo solves this by being periodically
cleaned; that is the posture adopted here. The engineering problem is narrow:
**make cleanup, quota, and banner behaviors that are safe to run unattended on one
instance, while making it structurally impossible for them to ship in a default
(self-hosted) deployment.** The second half is the hard invariant of §2 — the
README's self-host guarantee depends on it.

This SPEC is deliberately *not* a multi-tenancy design. In scope:

1. The `DEMO_MODE` gate contract and the hard invariant (§2).
2. The M0 prerequisite: a dead-letter queue for `repo-tasks` — empirically
   motivated by the 2026-10-28 e2e sweep's purge-drop finding (§3.0).
3. The 72 h demo sweep: hourly cron producer → `{kind: "demo-sweep"}` on the
   EXISTING `repo-tasks` queue → the existing serialized consumer drives the
   EXISTING delete cascade (§3).
4. Rate limiting (zone-level WAF runbook; optional in-app quotas), open demo
   signup, and the dismissible demo banner (§4).

Out of scope (§9 lists what stays out even later):

- **Multi-tenant SaaS**: billing, per-tenant isolation, an abuse/moderation
  pipeline, ToS enforcement. The demo is a courtesy display instance, not a
  product tier.
- **Anything that ships enabled in default configs** — the §2 invariant makes
  this structural, not advisory.
- **A persistent admin-notices D1 table** — upstream's `system notices`
  (`gitea/services/repository/delete.go:328-342`, the `CreateNotice` the delete
  path cites) has no cf-gitea table today (no `notice` table in
  `apps/worker/src/db/schema.ts`); the repo's standing admin-notice equivalent is
  observability logging (`apps/worker/wrangler.jsonc:134-136`,
  `apps/worker/src/repos/purge.ts:135-137`). M0 keeps that posture (§3.0).
- **The deploy-probes `demo` battery** — named in §7, built later, outside this
  SPEC's implementation scope.

### 1.1 Entry criteria (met — recorded for the gate discipline)

Unlike SPEC-0012/0013's demand-gated drafts, this SPEC's entry criterion is
already satisfied: the demo instance **exists and is deployed**
(`cf-gitea-demo.aiapp.run`), so the cleanup gap is live — every day of operation
without a sweep is accumulated garbage on a public writable instance. The
orchestrator's decision record approved the design parameters on 2026-10-28; this
document is the ratification draft.

## 2. The DEMO_MODE contract

**`DEMO_MODE` is an explicit environment gate** — a Worker var declared in
`apps/worker/wrangler.jsonc.example` under `vars` (alongside `APP_URL`,
`wrangler.jsonc.example:34-36`), **default OFF** in the example config. The var
rides the generated `Env` after `wrangler types` (the same declared-var discipline
as `APP_URL` — declared vars are typed required, undeclared vars never load, the
`MIRROR_EGRESS_MODE` contrast documented at
`apps/worker/src/services/mirror/sync.ts:139-142`).

ALL demo behaviors are compiled behind it — the cleanup cron arm, the UI banner,
the demo quotas. Concretely: every code path this SPEC adds begins with a
`DEMO_MODE !== "true"` (or equivalent falsy) check and returns/renders nothing
when the gate is off. The banner branch renders no DOM node when off (byte-identical
pages, the golden discipline `apps/worker/src/ui/shell.test.tsx` pins); the
producer arm never touches D1 or the queue; the quota checks never intercept a
create.

> **HARD INVARIANT (§-level, quoted from the orchestrator decision record):**
> **A self-hosted deployment with the default config NEVER schedules cleanup,
> NEVER deletes user data, NEVER rate-limits beyond the platform plan — README's
> self-host guarantee depends on this.**

This is a structural claim, not an advisory default, and it is testable (§7):
- *Never schedules cleanup*: with the var unset, the hourly cron invocation (§3.1)
  returns before its first D1 read — no SELECT, no enqueue. Asserted by unit test
  with a spy queue.
- *Never deletes user data*: the only new deletion driver is the sweep producer,
  which is dead without the gate; the delete cascade it calls is the pre-existing
  user-initiated path (SPEC-0003 §2.5.5), unchanged.
- *Never rate-limits beyond the platform plan*: the only in-repo rate limiting is
  the engine's pre-existing per-IP auth-failure limiter
  (`packages/git-engine/src/mod.ts:270`); every quota check in §4.3 is gated, and
  the WAF layer of §4.1 is dashboard configuration on the demo zone, absent by
  construction from any default deployment.

The gate value is read per-invocation from `env` — no module-level mutable state
(AGENTS.md Workers rules). Turning `DEMO_MODE` on/off is a `wrangler.jsonc` vars
edit + redeploy; there is no runtime toggle.

## 3. Cleanup design (M1)

The mechanism is the approved parameter, verbatim: **hourly cron → REPO_TASKS
queue messages of a new `{kind: "demo-sweep"}` shape → the existing serialized
consumer drives the EXISTING delete cascade (SPEC-0003 §2.5.5 path). Never a new
queue.**

### 3.0 PREREQUISITE (blocking, M0): the repo-tasks dead-letter queue

**The `repo-tasks` queue has no `dead_letter_queue` today** — after
`max_retries: 5` the message is **dropped** with only a per-attempt
observability-log trace (`apps/worker/wrangler.jsonc:129-136`: "No
dead_letter_queue yet: after max_retries the message is dropped"). The 2026-10-28
e2e sweep showed this failure mode empirically
(`docs/reviews/e2e-sweep-2026-10-28.md:104-112` + the storage-layer finding at
`:280-315`): a RepoCell destroy hit `SQLITE_LOCKED`, the queue purge retried 5×,
was **dropped**, and the cell survived as an orphan serving stale refs under a
name whose D1 row was gone — a 29/40 engine-suite excursion with silent data
leakage as the end state.

**A demo whose cleaner silently leaks is worse than no cleaner**: the demo's whole
point is bounded garbage; a purge that dies quietly makes the retention promise a
lie while the operator sees nothing. The DLQ is therefore a blocking M0 that lands
BEFORE any sweep producer exists:

1. `apps/worker/wrangler.jsonc` + `apps/worker/wrangler.jsonc.example`: the
   repo-tasks consumer gains `"dead_letter_queue": "repo-tasks-dlq"`, and the
   consumers array gains the DLQ consumer entry — the exact shape of the
   webhook-delivery precedent (`{ "queue": "webhook-delivery", "max_retries": 3,
   "dead_letter_queue": "webhook-delivery-dlq" }` +
   `{ "queue": "webhook-delivery-dlq", "max_retries": 1, "max_batch_size": 10 }`,
   `apps/worker/wrangler.jsonc:127-128`). The stale "No dead_letter_queue yet"
   comment (`wrangler.jsonc:134-136`) is deleted with the gap.
2. A DLQ handler module (`src/repos/dlq.ts`), porting
   `webhookDlqHandler`'s contract (`apps/worker/src/webhooks/dlq.ts:121-148`):
   per message, log the raw body verbatim under a stable `[repo-tasks-dlq]`
   prefix (the storageKey/engineNames or the typed `kind` — everything a manual
   redrive needs), then `ack`; a poisoned body is logged and acked the same way
   (`dlq.ts:130-134` posture). Unlike the webhook DLQ there is no D1 row to
   flip — the admin-notice surface is the observability log (§1 out-of-scope
   note), and **drain = manual redrive**: re-queue the logged message body to
   `repo-tasks` (wrangler queues redrive / a scripted `send`); every consumer
   step is idempotent (§3.4), so redelivery is safe by construction.
3. Dispatch arm in `src/index.ts`'s `queue()` before the repo-tasks fallback —
   the `webhook-delivery-dlq` branch precedent (`apps/worker/src/index.ts:251-253`).

M0 has no behavior change for green messages; it converts "silently dropped after
5 retries" into "logged + redrivable" for every message family on the queue
(purges, imports, mirror syncs, forks) — a product improvement independent of the
demo.

### 3.1 The hourly cron producer

Config: one entry added to the existing `triggers.crons` array —
`"0 * * * *"` beside the standing `"*/10 * * * *"`
(`apps/worker/wrangler.jsonc:108-110`, mirrored in
`apps/worker/wrangler.jsonc.example:113-115`). At :00 both entries fire as
separate scheduled invocations, each carrying its own `controller.cron` string —
the handler dispatches on it: the `*/10` invocations run the mirror producers
exactly as today (`apps/worker/src/index.ts:238-243`), the `0 * * * *`
invocation runs ONLY the demo producer, and **the demo producer checks `DEMO_MODE`
before its first D1 read** — gate off → return immediately (§2 invariant arm 1).
The mirror producers stay unconditional: a `*/10` invocation already covers every
minute-0 tick, and their CAS guard
(`apps/worker/src/services/mirror/sync.ts:903-910`) makes any overlap a no-op.

The CPU discipline is the approved parameter's, verbatim: **respects the sub-hour
30 s CPU rule by only SELECTing and enqueueing — the same pattern as the existing
`*/10` mirror producer** (`enqueueDueMirrorSyncs`,
`apps/worker/src/services/mirror/sync.ts:883-921`: SELECT due rows, CAS-claim,
`sendBatch` ≤ 100). The worker is the repo delete — done by the queue consumer,
which gets its own budget (queue consumers: 15 min wall + the CPU limit,
AGENTS.md Workers rules; the same note the mirror producer's wiring comment
carries, `sync.ts:86-88`). (An hourly interval would even qualify for the ≥1 h
15-min-wall budget — the producer-only shape is kept anyway for symmetry with the
landed pattern and because the 30 s budget is never a binding constraint for two
SELECTs.)

Producer shape (`src/services/demo-sweep.ts`, new; cf-gitea module conventions):

1. Gate: `env.DEMO_MODE` unset/not `"true"` → return 0 before any I/O.
2. SELECT candidates (LIMIT 50/tick, the mirror producer's page size,
   `sync.ts:885`):
   `repositories.created_at < now - 72 h` (hour resolution;
   `schema.ts:69-71` — `created_at` is the row-creation unix timestamp set
   explicitly by `RepoService.create`,
   `apps/worker/src/repos/service.ts:299`), INNER JOIN `users` on
   `repositories.owner_id` (`schema.ts:32`, indexed
   `repositories_owner_id_idx`, `schema.ts:223`) keeping rows where
   `users.is_admin = false` (`schema.ts:337`) — **admin-owned repos are exempt**,
   and rows whose `owner_id` is NULL (no exempting principal exists) are swept
   (fail-safe; every landed create path populates `ownerId` — API +
   push-create both go through `RepoService.create`,
   `service.ts:287-290`, and the gate's settle arms never clear it).
3. Enqueue one `{kind: "demo-sweep", repoId: <id>}` message per candidate via
   `env.REPO_TASKS.sendBatch` (≤ 100/call, `sync.ts:913` shape).
4. Log the batch counts: `console.log([demo-sweep] enqueued N of M eligible (cut
   <ts>)`) — **every sweep batch logs counts** (the approved observability
   parameter); 0-eligible ticks log a compact one-liner so the log proves the
   sweep ran.

**No CAS claim, unlike the mirror producer** (`sync.ts:903-910`): a mirror row
survives its sync so the CAS `idle → queued` is the enqueue arbiter; a swept repo
row is DELETED by the consumer (`service.ts:671`, the batch's final statement),
so row-deletion IS the claim — the next hour's SELECT simply misses it, and a
duplicate message (same repo enqueued twice across a tick boundary while a purge
is still draining) is absorbed idempotently by the consumer arm (§3.4). Simpler
than the mirror, on purpose.

### 3.2 The `{kind: "demo-sweep"}` message + consumer arm

Message: `{ kind: "demo-sweep"; repoId: string }` — the exact shape discipline of
`MirrorSyncMessage` (`sync.ts:150-153`), `PushMirrorSyncMessage`
(`apps/worker/src/services/mirror/push-sync.ts:114-116`), and the import family
(`apps/worker/src/repos/purge.ts:125-127`), with an
`isDemoSweepMessage` narrowing guard (the `isMirrorSyncMessage` shape,
`sync.ts:155-161`).

Consumer: a new arm in `handleRepoTasks`
(`apps/worker/src/repos/purge.ts:139-191`) BEFORE the
`isRepoPurgeMessage` fallback (positioned like the fork arm
`purge.ts:151-159`, whose placement lesson is recorded there). The arm:

1. Load the repo row; **gone → ack** (a delete raced the sweep — the mirror
   arm's missing-row posture, `sync.ts` flow step 1).
2. **Re-check age and exemption at consume time** (the row may have aged in or a
   user may have become admin since enqueue — §6.3): owner admin now, or
   `created_at` inside retention → ack, no delete.
3. Call `new RepoService(env.DB, { registry, queue: env.REPO_TASKS,
   tombstone }).deleteRepository(repo.id)` — **the existing cascade, unchanged**:
   D1 batch delete of the row + every dependent (the batch spanning
   `service.ts:565-671`, the repositories row the batch's final statement at
   `:671`), DO tombstone (`service.ts:674-685` +
   `purge.ts:60-67`), synchronous registry removal
   (`service.ts:688-702`), then the enqueue of the standard
   `{storageKey, engineNames}` purge message (`service.ts:705-713`) whose
   consumer run finishes the R2 prefix purge + `RepoDO.destroy()`
   (`purge.ts:195-227`). The demo arm adds **no deletion logic of its own** —
   it is a second caller of the same function the API's `DELETE
   /repos/{owner}/{repo}` route and the gate's engine-shape DELETE use
   (`apps/worker/src/git-http/gate.ts:591,638`).
4. The inner purge message flows through the same queue → consumer → DLQ
   machinery of §3.0 — a purge that dies retries, then dead-letters visibly
   (the exact scenario the 2026-10-28 sweep turned from silent into observable).

### 3.3 Retention semantics

- **Retention: 72 hours** (approved parameter). Age is `created_at`, not
  `updated_at` (last-activity would let a one-push-then-abandoned 10 GiB repo
  live forever, and makes the demo's promise harder to state).
- **Non-admin repositories** older than 72 h are cleaned. Org-owned repos: orgs
  are user rows with `type='org'` and `is_admin=false`
  (`schema.ts:337,363`) — org repos are swept (§6.2 documents why this is the
  correct reading of "non-admin").
- Retention applies by instance, configured by editing the constant in
  `src/services/demo-sweep.ts` (72 h default); it is NOT an env var — a second
  knob invites a default-config deployment to set a short retention and breach
  the §2 invariant's spirit. One gate, one constant, in code.

### 3.4 Idempotency (the cascade is already idempotent — cited)

Every step the sweep can trigger is idempotent, so queue redelivery (and the §3.0
redrive) is safe by construction — the cascade's own documentation states this:

- `deleteRepository`'s D1 batch is keyed on the row existing; a concurrent delete
  wins the race and the loser's `RepoService.get` throws `RepoNotExistError` —
  the engine-shape wrapper already treats that as success
  ("idempotent-delete semantics", `apps/worker/src/repos/purge.ts:260-265`); the
  demo consumer arm adopts the same catch-and-ack.
- `tombstoneRepoDO` is idempotent ("tombstoning an already-tombstoned …
  re-initializes an empty one and marks it", `purge.ts:55-59`).
- `purgeRepoStorage` is paged list+delete over an emptying prefix — re-running
  deletes nothing (`purge.ts:74-103`).
- `destroyRepoDO` is idempotent ("destroying a destroyed/never-created cell
  re-initializes an empty one", `purge.ts:105-110`).
- The consumer's own contract: "Per message: idempotent work, then ack; a throw
  retries THAT message (the redelivery re-runs the idempotent steps)"
  (`purge.ts:133-137`).

## 4. Rate limits, signup, banner

### 4.1 Zone-level WAF rate rules (ops runbook — configuration, not code)

The expensive surfaces are the git smart-HTTP pack endpoints
(`/*/info/refs`, `/*/git-upload-pack`, `/*/git-receive-pack` — the
`run_worker_first` pins, `apps/worker/wrangler.jsonc.example:82-89`) and the
`/api/v1` list endpoints. These are throttled OUTSIDE the repo with zone-level
WAF rate rules on the demo zone's dashboard: per-IP request-rate rules on the
upload-pack/receive-pack POST paths and generous-but-bounded rules on
`/api/v1/*` reads. This layer is **configuration on the demo zone, documented as
an ops runbook** (this section is the runbook seed; the standing rulebook lives
with the demo instance's ops notes, not in code) — a default deployment has no
such zone rules and the §2 invariant's "never rate-limits beyond the platform
plan" holds because nothing in the repo creates them.

### 4.2 Demo signup (open registration, demo instance only)

**Flagged gap (see §9 OQ-1): cf-gitea has no registration surface.** The worker
mounts exactly `/login` + `/logout` (`apps/worker/src/ui/session.ts:758-762`);
upstream serves `GET|POST /user/sign_up`
(`gitea/routers/web/web.go:595-596`) behind `DisableRegistration`, which
**defaults true** (`gitea/modules/setting/service.go:148`) with the navbar link
gated on the render flag
(`gitea/templates/base/head_navbar.tmpl:136-138`). "Open registration on the
demo instance only" therefore requires a NEW route — spec'd here as the
DEMO_MODE-gated arm that reuses the landed user-creation ladder:

- `GET|POST /register` (name chosen over upstream's `/user/sign_up` because the
  cf-gitea UI keeps top-level session routes single-segment — the SPEC-0010
  shape, `apps/worker/src/ui/session.ts` header), **mounted only when
  `DEMO_MODE` is on** (a mount-time gate branch in `src/ui/session.ts`; the
  default config's router never sees the route — the §2 "compiled behind it"
  reading at its strongest).
- The POST handler runs the same validation + insert the admin route runs:
  usable-username/email checks and the `insert(users)` ladder
  (`apps/worker/src/api/routes/admin-t2.ts:836-843`, insert at `:463`) minus the
  admin-only wrapper (`admin-t2.ts:155`); new demo users are `status='active'`,
  `is_admin=false` — they can never exempt their repos from the sweep (§3.1
  step 2), which is the point.
- The demo instance may equivalently be operated with admin-minted accounts only
  (`POST /admin/users`, `admin-t2.ts:836`) — decide at ratification (OQ-1); the
  sweep and quotas do not care which posture the instance picks.

### 4.3 In-app demo quotas (M2, gated — only what is cheap)

Investigation result, recorded because the approved parameter asked for the
engine's "existing quota seams": **the engine has no per-user/per-repo quota
enforcement seam.** What exists is (a) a GLOBAL per-request push-size cap —
`MAX_PUSH_MB` env read with `DEFAULT_MAX_PUSH_MB = 512` MiB
(`packages/git-engine/src/mod.ts:161,944`), enforced pre-read via
`overDeclaredLength`/`tooLargeResponse` (`mod.ts:947`,
`packages/git-engine/src/repo.ts:2431-2444`) and in-stream ("pack exceeds maximum
push size", `mod.ts:732`); and (b) settle-time repo-size **accounting** —
`syncRepoSizeFromStorage` persists `size_kb` after pushes
(`apps/worker/src/services/repo-size.ts:146-159`, column at
`apps/worker/src/db/schema.ts:136`) — measurement, not enforcement. Both are
ungated today and stay ungated (the push cap is a platform-memory bound, not a
policy).

Gated demo quotas, scoped to what is cheap:

- **Per-user repo count** (cheap, enforced): at repo create — API create and the
  push-create settle both resolve through `RepoService.create`
  (`service.ts:287`) — a gated `COUNT(*)` over `repositories_owner_id_idx`
  (`schema.ts:223`) refusing creation past the cap with the upstream-flavored
  403/422 text. Two call sites, one helper, one indexed query.
- **Per-repo size** (cheap, observe-then-refuse): the sweep producer already
  reads candidate rows; a gated size report rides the sweep log (§3.1 step 4)
  from `size_kb`. A pre-push refusal arm (one `SELECT size_kb` in the gate's
  receive path when the gate is on) is deliberately an OQ (OQ-4): it is cheap
  but touches the hot git path, and the WAF layer already bounds the practical
  abuse.

### 4.4 The demo banner (M2)

A DEMO_MODE render branch in the shell: when the gate is on, `BaseLayout`
(`apps/worker/src/ui/shell.tsx:393-441`) renders a fixed-height notice above the
`role="main"` div — text per the approved parameter ("data on this instance is
periodically cleaned"). **Dismissible per session**: an inline script flips a
`sessionStorage` key and hides the node; the dismissal never round-trips the
server (no endpoint, no D1). When the gate is off the branch renders **no DOM
node** — the golden snapshots (`apps/worker/src/ui/session-goldens/`,
`shell.test.tsx`) are untouched, which is itself the gate-off test (§7).

## 5. Data model

**No new tables. No migration.** The sweep reads only landed columns:

| What | Where | Notes |
|---|---|---|
| Age key | `repositories.created_at` (`apps/worker/src/db/schema.ts:69-71`) | NOT NULL, `unixepoch()` default, set explicitly by `RepoService.create` (`service.ts:299`) |
| Exemption | `users.is_admin` (`apps/worker/src/db/schema.ts:337`) + `repositories.owner_id` (`:32`, indexed `repositories_owner_id_idx` `:223`) | INNER JOIN at SELECT time; NULL owner → swept (§3.1) |
| Org discrimination | `users.type` (`:363`) | Not needed by the query — org rows simply have `is_admin=false` — but cited because §6.2's reasoning leans on it |
| Size observability | `repositories.size_kb` (`:136`) | Settle-time maintained, `services/repo-size.ts:146-159`; sweep-log only (§4.3) |

- **No `swept_at` marker**: the D1 row deletion IS the sweep's claim (§3.1 —
  the consumer deletes; the next SELECT misses). A marker would add a migration +
  a second writer for zero idempotency gain over the already-idempotent cascade
  (§3.4).
- **No `created_at` index**: the hourly candidate SELECT is demo-only
  (gate-gated) and LIMIT 50; a demo-scale `repositories` table (hundreds of rows)
  takes a trivial full scan once per hour. Proposing `repositories_created_at_idx`
  would put a migration in every default deployment for an index only a demo
  uses — rejected under the §2 invariant's spirit. Revisit ONLY if the demo
  instance's D1 metrics ever show the scan (recorded as the re-entry condition,
  not a plan).

The M0 DLQ adds config only (§3.0) — queues are not D1. Message shapes are TS
interfaces, no schema.

## 6. Edge cases, limits, failure modes

| # | Case | Behavior |
|---|---|---|
| 6.1 | **Sweep racing an active push** | Same ordering the user-delete path already guarantees (SPEC-0003 §2.5.5 + §4.2): D1 row first → repo resolution 404s; `markDeleted` tombstone refuses new receive leases and aborts an in-flight `finalizeReceive` inside the DO transaction with a sideband failure. A pusher pushing into a 73 h-old demo repo at the wrong moment gets a clean protocol error, never partial refs: "end state is still 'repo gone', no dangling reachable state" (`specs/0003-repo-lifecycle-git-http.md` §4.2 row). |
| 6.2 | **The admin exemption check** | Evaluated at SWEEP time against the owner's CURRENT `is_admin` (§3.2 step 2 re-checks at consume). Org-owned repos are swept: orgs are `type='org'` user rows (`schema.ts:363`) and an org row can never be `is_admin` — treating "org created by an admin" as exempt would make demo garbage immortal (anyone can create orgs on an open-registration demo). The demo's standing fixtures live under the bootstrap ADMIN user precisely so they survive (§6.4). |
| 6.3 | **User creates repo, later becomes admin** | The repo was sweeptime-candidate before the promotion; after promotion the producer's JOIN and the consumer's re-check both see `is_admin=true` → exempt. Exemption is a property of the owner NOW, not of the repo's creation-time owner — an admin's repos are never swept regardless of when created or who created them. (Inverse: an admin demoted to user exposes their repos to the sweep — acceptable on a demo; the operator's admin account is not demoted in practice.) |
| 6.4 | **Repo created before DEMO_MODE enabled** | `created_at` is absolute — flipping the gate on an instance with existing data makes already-old rows candidates at the FIRST tick. This is correct and bounded: the demo instance is being consciously demoted into cleanup posture, the first ticks drain at ≤ LIMIT 50/h (§3.1), and the admin-owned fixtures survive the transition. Documented operator guidance: flip `DEMO_MODE` on a fresh instance, or expect the backlog sweep. |
| 6.5 | **Purge dies mid-cascade** | Queue redelivery per the consumer's throw-and-retry contract (`purge.ts:133-137`); after `max_retries: 5` the message lands in the M0 DLQ and is LOGGED + redrivable (§3.0) instead of dropped — the exact 2026-10-28 sweep scenario (`docs/reviews/e2e-sweep-2026-10-28.md:280-315`), closed for every message family. |
| 6.6 | **Sweep message for a repo deleted by its user first** | Consumer loads the row → gone → ack (§3.2 step 1); the user delete already ran the same cascade. No error, no retry. |
| 6.7 | **Double enqueue across ticks** | Consumer drains far faster than the hourly cadence, and even a genuine duplicate is absorbed: first message deletes the row, second finds it gone → ack (§3.4). No CAS needed. |
| 6.8 | **`DEMO_MODE` set to a non-`"true"` value** (typo, `"1"`, `"on"`) | Treated as OFF (strict `"true"` comparison, §2) — the invariant is fail-closed; the sweep log's absence + the §7.1 test pin the arm. The runbook names the exact accepted value. |
| 6.9 | **A user's LAST repo swept out from under an active session** | Upstream-invisible to us: sessions are independent of repo rows (SPEC-0010); the UI resolves the repo per request and renders the standard unknown-repo 404. No dangling state to clean. |
| 6.10 | **`repo-tasks` backlog starvation** (many purges + a slow R2 prefix) | The consumer is serialized (`max_batch_size: 1, max_concurrency: 1`, `wrangler.jsonc:130-133`); the sweep adds ≤ 50 deletes/hour against a queue that already absorbs user deletes + mirror syncs. The LIMIT (§3.1) is the deliberate throttle — the demo drains over hours, never bursts. |

## 7. Testing plan

- **Unit (gate-off — the invariant tests, run first, always)**:
  1. `enqueueDueDemoSweeps` with `DEMO_MODE` unset / `"false"` / `"1"`: returns 0
     and the spy queue records ZERO `send`/`sendBatch` calls — and (the stronger
     arm) the spy D1 records zero queries: nothing schedules (§2).
  2. The scheduled-handler dispatch: `controller.cron === "0 * * * *"` with the
     gate off → the mirror producers still run (their unconditional posture,
     §3.1) and the demo producer is a no-op; with the gate on, the `*/10` string
     never triggers a sweep (dispatch table over both cron strings × both gate
     states).
- **Unit (armed)**: candidate-selection table (age boundary at exactly 72 h;
  admin-owned exempt; org-owned swept; NULL-owner swept; LIMIT truncation
  oldest-first); `isDemoSweepMessage` narrowing incl. rejection of the other
  families' shapes (`purge.ts:45-53`, `sync.ts:155-161` shapes as negatives).
- **Integration (vitest-pool-workers, real D1 — the `repos/lifecycle.test.ts`
  pattern)**: seed repos past/inside retention across
  admin/user/org owners → run the producer → assert the enqueued
  `{kind: "demo-sweep", repoId}` set → run the consumer arm → assert rows gone,
  the cascade's side effects match the landed lifecycle tests (redirects cleared,
  purge message `{storageKey, engineNames}` enqueued), the exemption re-check
  flips (§6.3), and the raced-delete ack (§6.6). The cascade itself is NOT
  re-tested here — `deleteRepository` is already pinned by
  `repos/lifecycle.test.ts`; the sweep's own assertions stop at "the right
  function was called with the right row" plus end-state row absence.
- **Integration (M0)**: DLQ handler unit — a purge-shaped message logs verbatim
  and acks; a poisoned body acks (the `dlq.test.ts` pattern,
  `apps/worker/src/webhooks/dlq.test.ts`).
- **Golden/DOM**: gate-off banner absence — the existing goldens
  (`apps/worker/src/ui/session-goldens/`) pass UNCHANGED, which is the
  byte-identical proof; gate-on golden adds the banner node + the dismissal
  script.
- **E2E (later, named here, out of this SPEC's build scope)**: the
  `deploy-probes` toolkit gains a `demo` battery (the battery list,
  `scripts/deploy-probes.README.md:20-24`): arm the gate on a local/remote run,
  backdate a repo's `created_at` via wrangler d1 (the toolkit's first backdate
  WRITE — the `fixwave-parity` session-rotation D1-write precedent,
  `deploy-probes.README.md:265-268`), tick the producer path, assert the delete,
  assert the banner, then run a gate-off pass asserting nothing schedules. The
  battery self-cleans per the toolkit's consistency posture
  (`deploy-probes.README.md:350-384`).
- **Contract**: no `/api/v1` surface changes (the sweep is not an API; the
  register route, if OQ-1 lands it, is a web route outside the frozen swagger) —
  `pnpm check:api` unchanged is itself the assertion.

## 8. Milestones, effort

Effort in **wave units where 1 wave ≈ one background-agent landing unit with
review** (SPEC-0012 §5 convention); S/M/L: S ≤ 0.5 wave, M ≈ 0.5–1.5, L > 1.5.

| # | Milestone | Content | Est. | Why |
|---|---|---|---|---|
| **M0** | **repo-tasks DLQ** (BLOCKING prerequisite — lands before any sweep) | `dead_letter_queue: "repo-tasks-dlq"` + consumer entry in `wrangler.jsonc` AND `wrangler.jsonc.example` (§3.0); `src/repos/dlq.ts` handler (the `webhooks/dlq.ts` port); dispatch arm in `src/index.ts`; tests; redrive runbook paragraph | **S** | Config + one small module over a proven precedent (`webhook-delivery-dlq`, `wrangler.jsonc:127-128`); benefits every queue family immediately |
| **M1** | **Gate + sweep** | `DEMO_MODE` var in the example config (default OFF) + `wrangler types`; hourly cron entry + `controller.cron` dispatch; `src/services/demo-sweep.ts` producer (SELECT+JOIN+enqueue, LIMIT 50, count logging); `{kind: "demo-sweep"}` consumer arm in `handleRepoTasks` driving `deleteRepository` (§3.2); §7 unit + integration tests | **M** | All seams exist; the new code is one producer module + one consumer arm; the risk is the invariant tests, not the machinery |
| **M2** | **Banner + quotas + signup** | Shell banner branch + session dismissal (§4.4); gated per-user repo-count quota at both create paths (§4.3); sweep size reporting; the `/register` arm IF OQ-1 lands open registration (else admin-minted posture is zero-code); WAF runbook finalized in ops notes | **M** | The banner and quota are small; OQ-1 is the sizing variable — with registration the M2 grows by the route + form + tests (~+0.5 wave) |

Total: **S + M + M ≈ 2–3 waves**. M0 is independently valuable and lands first;
M1 makes the demo self-cleaning; M2 is the polish wave. Deliberately NOT built in
v1: persistent admin notices (§1), per-repo size pre-push refusal (OQ-4),
per-task-type DLQ metrics dashboards, any cron other than the one hourly entry.

## 9. Open questions (resolve at ratification)

- **OQ-1 (M2 sizing)**: Open demo registration — the approved parameter assumes
  it, but cf-gitea has NO registration surface today (only `/login`+`/logout`,
  `apps/worker/src/ui/session.ts:758-762`; upstream's `/user/sign_up` defaults
  DISABLED, `gitea/modules/setting/service.go:148`). Land the DEMO_MODE-gated
  `/register` arm (§4.2, reusing the `admin-t2.ts:836` ladder), or operate the
  demo with admin-minted accounts? Recommendation: land the arm — an open demo
  where visitors cannot self-register underserves the display purpose.
- **OQ-2 (config shape)**: The hourly cron entry in the EXAMPLE config (a dead
  trigger on gate-off deployments — one no-op invocation/hour, dispatch-guarded
  §3.1) vs. adding the entry only to the demo instance's gitignored real config.
  Recommendation: the example carries it — config monogeneity
  (`wrangler.jsonc` single source of truth, AGENTS.md) beats a hand-maintained
  demo delta whose worst failure is a silently-armed-but-never-firing sweep.
- **OQ-3 (notices)**: Keep the DLQ admin-notice surface as observability logs +
  manual redrive (§3.0 — zero new tables), or introduce a persistent
  admin-notices D1 table (the upstream `CreateNotice` port,
  `delete.go:328-342`)? Recommendation: logs for v1; a notices table is a
  product feature, not a demo prerequisite.
- **OQ-4 (M2)**: Pre-push per-repo size refusal in the git gate (one gated
  `SELECT size_kb` before receive) vs. sweep-log observability only (§4.3).
  Recommendation: observability only for v1 — the WAF layer bounds practical
  abuse, and the hot path stays untouched.
- **OQ-5 (product)**: Retention constant placement — in-code constant (§3.3,
  recommended) vs. an env var. The var invites default deployments to shorten
  retention; the invariant's spirit says the fewer knobs the better.

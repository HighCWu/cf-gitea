# Actions Control-Plane Parity Review — services/actions vs upstream @ fc493688

Read-only parity review of the Actions control plane: `apps/worker/src/services/actions/**`
(plus its route mounts in `apps/worker/src/index.ts`) against upstream Gitea at the
submodule pin `fc493688` — `gitea/routers/api/actions/`, `gitea/services/actions/`,
`gitea/models/actions/`, `gitea/modules/actions/`, `gitea/modules/setting/actions.go`
and `gitea/services/cron/tasks_actions.go`. The runner wire is frozen on
`gitea.dev/actionslib` v1.5.0; the go.sum pin (`gitea/go.sum:15`,
`h1:dC3v2HTWbbvyNBSdg2W3kd4WNC/p+FnZaKpl1MdzM00=`) matches the hash recorded in
`apps/worker/src/services/actions/proto/WIRE-FREEZE.md` — the frozen wire shapes are
verified, and this review judges SEMANTICS beyond the freeze.

Severity: **High** = a real act_runner or real workflow hits wrong behavior on a
normal flow; **Medium** = hits on a plausible flow or leaves wrong durable state;
**Low** = corner case, error-shape, or cosmetic; **Info** = deliberate, documented
divergence judged acceptable.

## Verdict summary

| Area | Verdict | Top drift |
|---|---|---|
| Wire + interceptors | Solid parity | — |
| Runner lifecycle (register/declare/heartbeats) | Solid parity | heartbeat write failure fails the RPC (Low) |
| Dispatch fairness | Parity with one platform bug | owner-scope IN-list can exceed D1's 100-bind cap (Medium) |
| Task state machine | Mostly parity | UpdateTask echoes UNSPECIFIED (not CANCELLED) while cancelling (Medium); claim is not atomic (Low-Med) |
| Cancelling handshake | Parity | — |
| Zombie / endless / abandoned sweeps | Partial port | stalled cancelling task stopped as FAILURE not CANCELLED (Medium); endless + abandoned sweeps missing (Medium) |
| Log chunk protocol | Byte-level parity | append accepted into an expired hot log (Low) |
| Artifacts v1 | Parity (staged rerun inheritance) | partial-rerun artifact inheritance deferred (Low now) |
| Artifacts v4 | Parity | EXPIRED rows downloadable/listable (Low); no legacy-token arm on twirp group (Low) |
| OIDC | Shape parity, two claim bugs | default audience missing slash; subject format differs (Medium-High) |
| Retention | Deliberately divergent | default deployment never sweeps (Info/Medium); ephemeral cleanup rides the arming gate (Medium) |

---

## 1. Runner lifecycle (registration, declaration, heartbeats)

**Verdict: solid parity.** Registration token semantics match upstream exactly:
a token is reusable until reset; `newRunnerTokenWithValue` deactivates every
same-scope active token before inserting the new one (`models/actions/runner_token.go:74-98`
vs `model.ts:183-220`); `getOrCreateActiveRunnerToken` reuses the latest while
active (`runner_token.go:125-131` vs `model.ts:257-267`). Skipping upstream's
post-success `IsActive = true` write (`runner/runner.go:96-99`) is correct at this
pin — the token is already active; that write is vestigial. Register/Declare error
messages, the `cancelling` capability wiring, the `X-Gitea-Actions-Capabilities:
job-summary` response header (`runner.go:151-154`), name truncation
(`EllipsisDisplayString(…, 255)`), and the one-plaintext-token-return rule all match.

Heartbeats: the debounced `last_online` (30 s) / `last_active` (5 s, UpdateTask +
UpdateLog only) bookkeeping matches `models/actions/runner.go:75-98` byte-for-byte
(`model.ts:348-369`, `routes.ts:262-279`), and the runner status thresholds
(offline 1 min, idle 10 s) exist upstream-side only in display code — no drift found
in what we persist.

- **Low — heartbeat write failure fails the RPC.** Upstream logs and continues when
  the debounced heartbeat UPDATE fails (`routers/api/actions/runner/interceptor.go:86-90`:
  `log.Error("can't update runner status")`, then proceeds). Ours `await updateRunner(...)`
  inside `withRunner()` lets a D1 hiccup 500 the FetchTask/UpdateLog call itself
  (`routes.ts:273-275`). Rare, but a poll storm against a throttled D1 turns into
  runner-visible errors where upstream stays quiet.
- **Nit — FetchTask fresh-runner miss.** Upstream answers `codes.Internal` when the
  re-loaded runner vanished (`runner.go:192-195`); ours silently returns an empty
  task with the latest version (`dispatch.ts:152-157`). Observationally near-identical
  (the runner is gone either way), but the error shape differs.
- **Nit — Register create-failure message.** Upstream wraps insert failures as
  "can't create new runner" (`runner.go:91-93`); ours surfaces the raw D1 error text
  as CodeUnknown (`register.ts:113` via `routes.ts:330-332`).

## 2. Dispatch fairness (label matching, version cascade, CAS posture)

**Verdict: faithful port with one platform-specific bug.**

- Label matching is exact upstream: `CanMatchLabels` = non-empty runs-on AND every
  label contained case-insensitively (`models/actions/runner.go:202-205`); ours is
  the same predicate (`model.ts:373-379`). The `task_id = 0 AND status = waiting AND
  is_reusable_caller = false` scan, the scope narrowing (repo / owner-with-actions-unit
  / global), oldest-first keyset pagination on `(updated, id)` with the
  "read cursor before a lost claim bumps Updated" subtlety, and the move-on-on-lost-race
  loop all mirror `models/actions/task.go:265-327` (`model.ts:639-724`).
- tasks_version: the 0→1 bootstrap so runners never see version 0
  (`runner/runner.go:176-187`), the throttle echo that keeps the runner's stale
  version so it retries on its next poll (`runner.go:202-207`), the disable
  re-load race guard (`runner.go:189-195`), and the global→owner→repo cascade with
  the version-1 self-heal re-insert (`models/actions/tasks_version.go:54-101`) are
  all ported (`dispatch.ts:134-168`, `model.ts:385-447`). Upstream runs the cascade
  in one transaction; ours is update-then-conditional-insert per scope with the
  monotonicity argument documented — a lost race only delays the next wake, never
  resets a counter. Acceptable.
- The pick limiter (16, `modules/setting/actions.go:11,45` + `services/actions/task.go:31-53`)
  is per-isolate here vs upstream's per-process — documented; the CAS remains the
  correctness mechanism. The throttled path answers without touching the DB,
  matching `task.go:41-53`.
- **Medium — owner-runner dispatch breaks past ~95 repos in scope.**
  `scanAndClaimWaitingJobs` narrows owner-runner scans with
  `inArray(actionRunJobs.repoId, scopeRepos)` where `scopeRepoIds` returns EVERY
  actions-enabled repo id of the owner (`model.ts:639-653`, `model.ts:692-697`).
  The query already spends 3+ binds on the base predicates, so an org with more
  than ~95 actions-enabled repos pushes the statement past D1's 100-bind-per-query
  cap (the same cap the codebase chunks inserts around, e.g. `update.ts` step
  batching). Every FetchTask from that org's runner then errors
  ("too many SQL variables") until the runner flaps offline. Upstream has no such
  ceiling (`builder.In` subquery, `task.go:274-277`). A real self-hosted org runner
  on a busy org hits this deterministically. (Repo runners and global runners are
  unaffected — only the owner-scope IN-list materializes ids.)
- **Low — claim-context legs that differ.** The ported `GenerateGiteaContext`
  slice (`services/actions/context.go:76-139`) has three constant/fallback legs:
  `retention_days` is always `""` where upstream reflects the armed
  `ARTIFACT_RETENTION_DAYS` (`context.go:101-103` — v3 `upload-artifact` reads it
  as a runner-side default; harmless here because the server clamps expiry at
  upload anyway); `triggering_actor` is always `""` where upstream names the
  re-run attempt's trigger user (`context.go:108`, `:186-200`); and
  `gitea_default_actions_url` is always the instance origin where upstream
  defaults to `github.com` (`context.go:118` + `setting/actions.go:45-58`) — the
  self posture is deliberate for this platform but changes which `uses:` shorthands
  resolve. `ref_protected` is likewise hardwired `false` at claim time
  (`dispatch.ts:429-431`) pending SPEC-0013; `run_attempt`, `api_url`,
  `server_url`, the pull_request/pull_request_target ref/sha rewrites, and the
  task-scoped `token` / `gitea_runtime_token` / `actions_id_token_request_*` trio
  all match (`dispatch.ts:357-473`).

## 3. Task state machine (terminal states, job mirroring, side effects)

**Verdict: the state machine itself is parity; two side-effect gaps.**

- Status/Result mapping, terminal set (success/failure/cancelled/skipped), the
  "final state is a no-op" rule, the cancelling-preservation arm (runner may report
  SUCCESS/FAILURE during cleanup; user intent preserved → CANCELLED),
  `StatusFromResult`, and `AggregateJobStatus` (including the continue-on-error
  "continued failure" rule and the blocked/pending rankings) are line-level ports of
  `models/actions/status.go`, `task.go:481-566` and `run_job.go:642-687`
  (`update.ts:54-124`, `update.ts:437-499`). Upstream's fail-fast matrix arm inside
  the cancel-vs-failure aggregation is correctly omitted (matrix rows are an M3
  payload; the arm can never fire on v1 rows).
- **Medium — UpdateTask echoes UNSPECIFIED while cancelling; upstream echoes
  CANCELLED.** Upstream's response result is `task.Status.AsResult()`
  (`runner/runner.go:278-284`), and `AsResult` maps `StatusCancelling →
  Result_CANCELLED` (`models/actions/status.go:103-113`). Our `statusToResult`
  (`model.ts:67-80`) has no cancelling arm, so while a cancelled job is still in its
  cleanup phase every UpdateTask response carries `result = 0` where upstream
  carries `result = 3`. Runner-version dependent who consumes it, but it is exactly
  the wire value a newer act_runner's report loop can read to learn "you were
  cancelled"; it also feeds `needs`-result consumers through the same mapping. The
  fix shape is one case arm in `statusToResult` (or an `asResult` twin used by
  `updateTask`).
- **Low-Medium — the claim is not atomic.** Upstream claims inside ONE transaction:
  insert task, set `log_filename`, insert workflow steps, conditional job update,
  all committed or nothing (`task.go:333-414`). Ours inserts the task row, then CASes
  the job, then deletes the task on CAS loss (`dispatch.ts:230-302`). A crash (or an
  isolate eviction) between insert and CAS strands an orphan task row in RUNNING
  whose job is still waiting — and an ephemeral runner holding that orphan then
  fails `pickTask`'s one-task-per-lifetime check forever (`dispatch.ts:179-197`
  sees a live-status prior task and silently retries, never reaching the
  remove arm). Upstream's transaction makes the orphan impossible. A D1 batch
  (insert + conditional job update, delete-on-zero-rows) would restore the
  invariant.
- **Low — release does not wake sleeping runners.** Upstream's
  `ReleaseTaskForRunner` returns the job to waiting via `UpdateRunJob`, whose
  waiting arm bumps tasks_version (`run_job.go:503-510`), so idle runners re-poll
  promptly after a payload-assembly failure. Ours `releaseTaskForRunner` resets the
  job (`model.ts:731-742`) without a bump; the job waits for the next unrelated
  bump. Dispatch latency blip, not a correctness loss (runners poll on their own
  interval regardless).
- **Info — staged side effects.** Upstream's UpdateTask also creates commit
  statuses on every report and runs the M3-emitter family
  (`runner.go:263-276`); ours substitutes `refreshRunStatus` + the
  hasWaitingJobsToPick-gated version bump (`update.ts:583-592`), explicitly staged
  (module header). `EmitJobsIfReadyByRun` is likewise upstream-only
  (`services/actions/job_emitter.go:31`). Consistent with the staged plan; listing
  for completeness since it is a visible difference once runs have jobs whose
  commit-status consumers exist.
- **Info — concurrency posture.** Upstream serializes task reports per run via a
  global lock + transaction (`task.go:561-565`); ours is a plain read-modify-write.
  Terminal-vs-progress interleavings resolve to the same final status (the progress
  arm only touches `updated`), and runner-side reporting is sequential per task, so
  the practical exposure is limited to step-row churn from racing reports.

## 4. Cancelling handshake timing

**Verdict: parity.** `stopTask` implements upstream `StopTask`
(`models/actions/task.go:568-645`): CANCELLING only negotiates when the runner row
exists, advertises the `cancelling` capability, and reported within
`taskReportTimeout` (60 s, `task.go:65`); otherwise it collapses to CANCELLED.
Both preserve the runner's last-contact `updated` on the cancelling arm (upstream
via `NoAutoTime`, ours by simply not writing `updated`), so re-cancelling an
already-cancelling task does not defer the timeout. Terminal stops update task +
job + steps identically (`update.ts:613-672`).

The gap is in who calls stopTask with what — see section 5.

## 5. Retention and sweeps (zombie, endless, abandoned, cleanup)

**Verdict: the zombie arm is ported with a status bug; two upstream sweeps are
missing; the cleanup family is deliberately gated.**

Upstream's always-on jobs (`gitea/services/cron/tasks_actions.go:26-87`):
`stop_zombie_tasks` @every 5m (RunAtStart), `stop_endless_tasks` @every 30m,
`cancel_abandoned_jobs` @every 6h, `start_schedule_tasks` @every 1m,
`cleanup_actions` @midnight, `cleanup_action_runs` @midnight. Ours: a `*/10 * * * *`
entry carries the probe-gated zombie producer and an `0 * * * *` entry the
retention producer (`wrangler.jsonc.example:171`, `services/demo-sweep.ts`).

- **Medium — stalled CANCELLING tasks stop as FAILURE, upstream stops them as
  CANCELLED.** Upstream's sweep picks the stop status per task:
  `stopStatus = StatusFailure; if task.Status == StatusCancelling { stopStatus =
  StatusCancelled }` (`services/actions/clear_tasks.go:151-193` after
  `StopZombieTasks` at `:26-30`). Ours selects `[6, 8]` together and calls
  `stopTask(d1, task.id, ACTION_STATUS_FAILURE)` for both (`retention.ts:204-226`).
  A user-cancelled job whose runner died mid-cleanup records FAILURE — which then
  propagates through `AggregateJobStatus`'s `hasFailure` arm and flips the run (and
  any downstream branch protection / badge) to failed instead of cancelled.
- **Medium — `stop_endless_tasks` and `cancel_abandoned_jobs` are not ported.**
  Upstream stops RUNNING tasks whose START passed `EndlessTaskTimeout` (3 h,
  `clear_tasks.go:32-39`, `setting/actions.go:133-135`) and cancels
  waiting/blocked/pending jobs unclaimed for `AbandonedJobTimeout` (24 h,
  `clear_tasks.go:195-214`). Neither sweep exists anywhere in our tree (only the
  EndlessTaskTimeout constant feeding token expiry, `secrets.ts:62`). Consequences
  for a self-hoster: a task whose runner streams `updated` forever (a hung
  `sleep`-loop step) runs until the instance dies of old age, and a job parked in
  waiting (e.g. emitted for a runner label nobody serves) sits forever with the run
  stuck RUNNING — upstream auto-cancels both. The zombie sweep does NOT cover
  these: it keys on a stale `updated`, and endless tasks keep touching it.
- **Info/Medium — the default deployment never sweeps.** Upstream is always-on
  with defaults 90/365/400 days (`setting/actions.go:10-15,89-91`): artifacts
  expire at upload against the default 90-day ceiling, logs and runs are deleted
  nightly. Ours arms only on an operator-set positive-int var
  (`retentionDaysFromEnv`, `retention.ts:331-335`); unset means nothing is ever
  deleted. This is the ratified fail-closed posture (module header, SPEC §4.5) and
  the right call for a Workers deployment — but it IS a behavioral difference a
  self-hoster migrating from Gitea must be told about: their storage grows forever
  unless they set `ACTIONS_{ARTIFACT,LOG,RUN}_RETENTION_DAYS`. Judged Info because
  deliberate and documented, Medium in effect if undocumented in operator docs.
- **Medium — ephemeral-runner cleanup rides the arming gate.** Upstream runs
  `CleanupEphemeralRunners` unconditionally inside every nightly Cleanup
  (`cleanup.go:34-47,144-165`). Ours runs it inside `runRetentionSweep`, which only
  executes when a retention message arrives — which only happens when at least one
  retention var is armed (`retention.ts:100-104`, `retention.ts:364-448`). On a
  default deployment the only ephemeral deletion paths left are the happy-path
  ones (pickTask's remove-on-finished, UpdateTask's done arm); ephemeral runners
  whose runner process crashed before finalizing linger forever as zombie rows
  (visible in the runners UI, holding their tokens). Upstream sweeps them nightly.
- **Medium-Low — a terminal `stopTask` skips its three piggybacked side effects.**
  Upstream's StopTask path, through model hooks, (a) auto-deletes the ephemeral
  runner when the task flips done (`models/actions/task.go:452-464`), (b) bumps
  tasks_version when the job's terminal status leaves waiting siblings
  (`run_job.go:511-530`), and (c) the sweep transfers the dead task's logs to
  object storage and releases the hot rows (`clear_tasks.go:177-187`). Ours
  `stopTask` does none of the three (`update.ts:613-672`): zombie-killed ephemeral
  runners survive, sibling waiting jobs wait for an unrelated bump, and killed
  tasks' logs stay as unsealed `action_log_chunks` rows in D1 until log retention
  is armed (upstream archives them regardless of retention settings). The log-row
  accumulation is the practical one: a fleet of killed tasks grows the hot table
  with no seam to shrink it.
- **Info — cadence.** Hourly retention vs upstream @midnight: behaviorally
  equivalent — both sweeps are idempotent "older than X" passes, so running up to
  24x more often changes nothing observable except DB load and deletion latency
  (worst case ~1 h instead of ~24 h past a deadline). The 10-minute zombie entry vs
  upstream's 5 m doubles the worst-case kill latency for a dead runner's task
  (~zombie timeout + 10 m + queue latency). Neither matters behaviorally for a
  self-hoster; the arming gate and the missing arms above do.

## 6. Log chunk protocol (trim / ack / resend / past-seal)

**Verdict: byte-level parity on the protocol; one corner-case gap past expiry.**

`updateLog` is a faithful port of `routers/api/actions/runner/runner.go:288-359`:
the ack trim (`req.index <= ack && rows.length + req.index > ack`), the archived
guard answering connect `AlreadyExists` for appends past the seal, the idempotent
re-sent finalize, the bail branch (no new rows and not a legal NoMore — including
the NoMore gap guard `req.index > ack`), the render-even-with-zero-rows bootstrap,
and the seal ordering (object durable first, then flip `log_in_storage` + drop rows)
mirroring TransferLogs → UpdateTask → remove() (`update.ts:701-799`). The line
format (`RFC3339 7-digit UTC`, `\n` escaping, 64 KiB MaxLineSize truncation —
byte-safe here vs upstream's byte-slice), the zigzag `LogIndexes` varints, the
per-row size accounting, and the ack index all match `modules/actions/log.go`.
Upstream's `WithReadMaxBytes(0)` note (runners send all pending rows in one
UpdateLog) is honored by unbounded decode.

- **Low — an append into an expired hot log is accepted.** Upstream's DBFS
  `WriteLogs` refuses to create the file when `offset > 0` precisely to prevent
  content holes after transfer/removal (`modules/actions/log.go:35-57`, the #25560
  rule), so an UpdateLog with new rows against a removed hot log errors. Ours has
  no equivalent: after `cleanupExpiredLogs` deletes the chunk rows and clears
  `log_indexes` (`retention.ts:144-168`), a still-alive runner (zombie-adjacent
  timing) that appends gets its rows inserted at `seq` 0 with index bookkeeping
  rebuilt from the stale `log_size` — a corrupted log family instead of a clean
  error. Requires an expired log plus a runner still writing; the guard is
  one `if (task.logExpired)` away.
- **Info — sealed logs are uncompressed** (the `LOG_COMPRESSION=none` shape;
  upstream defaults to zstd). Documented divergence; affects storage size only,
  not the protocol.
- **Info — zombie-stopped tasks' logs stay hot** (see section 5); the read path
  (`readLogs`) serves them fine from chunks, so the UI/logs API see no difference
  until retention cleans them.

## 7. Artifacts

**Verdict: v1 and v4 are close ports; expiry and signed-URL semantics are parity;
three low drifts.**

- v1 vs v4 selection rules match: the twirp v5 routes ride the runtime JWT with
  task-must-be-RUNNING (`artifactsv4.go:143-159` + `artifacts.go:141-192`), v1
  additionally accepts the legacy raw 40-hex task token via the last-eight scan
  restricted to running/cancelling (`models/actions/task.go:187-236` vs
  `artifacts-v1.ts:78-102`). Upload-time expiry is computed in CreateArtifact only,
  clamping a requested expiry up to tomorrow and down to the armed retention
  ceiling, keep-forever otherwise (`models/actions/artifact.go:94-107` vs
  `artifacts.ts:101-115`) — identical arithmetic, and identical call sites (v1
  `retentionDays` query param, v4 `expires_at`). Signed URLs: HMAC-SHA256 over the
  length-prefixed ("v4", endpoint, expires, artifactName, taskID, artifactID)
  tuple, base64rawurl, 60-minute expiry, constant-time compare, clock check, and
  task-must-be-running on verify — byte-for-byte upstream
  (`artifactsv4.go:163-261` vs `artifacts-v4.ts:237-388`, `secrets.ts:481-518`).
  Block/blocklist upload ordering, blocklist delete-on-read, the "blockmap is
  required for chunks > 1" rule, contiguity planning against compressed size, the
  sha256 checksum verify, and md5-verified v1 chunks all match
  (`artifacts_chunks.go` vs `artifacts-merge.ts`).
- **Medium (when re-runs land) — v1 partial-rerun artifact inheritance deferred.**
  Upstream `GetArtifactAttemptIDs` lets a partially re-run attempt read the
  artifacts of the attempt it re-ran from (`models/actions/run_attempt.go:100-134`);
  ours returns `[ownAttemptId]` only (`artifacts.ts:249-253`), documented as the v2
  rule (SPEC §1.4). With reruns not yet produced by our trigger chain this is
  latent; the day rerun ships, passthrough jobs' `actions/download-artifact` will
  404 where upstream serves the inherited files. Flag it now so it lands with rerun.
- **Low — EXPIRED rows are downloadable/listable in v4.** Upstream's
  `getDownloadableArtifactByName` filters `status = CONFIRMED` only
  (`artifactsv4.go:269-273`); ours passes `status: 2` PLUS `finalizedArtifactsV4`
  which admits CONFIRMED **or EXPIRED** (`artifacts-v4.ts:412-422` with
  `artifacts.ts:226-233`), so between expiry-flip and the cleanup sweep a v4
  download can still serve bytes upstream refuses (and ListArtifacts can list it).
  Self-heals once the sweep deletes the object.
- **Low — the v4 twirp group has no legacy-token arm.** Upstream mounts the FULL
  `ArtifactContexter` (JWT or legacy raw token) on the five twirp posts
  (`artifactsv4.go:147-153`); ours accepts the JWT only (`artifacts-v4.ts:287-315`).
  A pre-runtime-token runner (or a tool replaying the raw `GITEA_TOKEN` against v4)
  gets a 500 where upstream authenticates. Vanishingly rare fleet segment.
- **Info — storage naming.** Upstream's merged path carries a nanotime + extension
  and deletes the old object on re-merge (`artifacts_chunks.go:298-309,392-397`);
  ours uses the deterministic `actions/artifacts/<run>/<artifact>` key, so a
  re-merge overwrites in place — same end state, no orphan. The `expires` string
  spells `+0000 UTC` vs upstream's local-zone Go layout — opaque to the runner,
  and our build+verify pair is self-consistent.

## 8. OIDC id-tokens

**Verdict: protocol/discovery parity, claim-set shape parity, two real claim
value bugs.**

Discovery (`issuer`, `jwks_uri`, response/subject types, RS256, claims_supported
with the exact registered+struct-field list, `scopes_supported: ["openid"]`), the
`WWW-Authenticate: Bearer` + 401 on permission denial, `Cache-Control: no-store`,
and the `{value: idToken}` response all match `routers/api/actions/oidc.go:17-59`.
The exchange rules match: bearer must carry the `Actions.IDTokenRequest` scope
(exclusive both ways, `services/actions/auth.go:86-94`), task must exist and be
RUNNING or CANCELLING (cleanup steps, `services/actions/oidc.go:118-122`), and the
job's token_permissions must grant id-token — null denies (`oidc.go:115-124` vs
`oidc.ts:81-91`). Token registration claims: RS256 with the SPKI-fingerprint kid,
5-minute expiry with the 5-minute not-before backdate, iat, random jti,
`runner_environment: "self-hosted"` (`services/actions/oidc.go:190-196` vs
`oidc.ts:138-170`). RSA-2048 vs upstream 4096 is the documented Workers-cost
divergence. The claim guard is staged: upstream additionally recomputes
`ComputeTaskTokenPermissions` (org/repo clamps, fork/cross-repo read-only) and
requires the recomputed grant (`services/actions/oidc.go:123-125`,
`models/actions/token_permissions.go:16-60`); ours trusts the stored row
(`oidc.ts:75-91`, header comment says the clamp lands with the actions-config
family). Until then, whatever the M3 producer writes into `token_permissions` is
the effective grant — a fork-PR clamp gap is possible if it stores unclamped
declared permissions.

- **Medium-High — the default audience is malformed.** Upstream:
  `setting.AppURL + url.PathEscape(run.Repo.OwnerName)` → `https://host/owner`
  (`services/actions/oidc.go:179-182`; AppURL always carries the trailing slash).
  Ours strips the trailing slash at the call site (`oidc.ts:247`) and then
  concatenates without one: `audience = appUrl + encodeURIComponent(ownerNamespace)`
  → `https://hostowner` (`oidc.ts:125-127`). Every workflow that requests an
  ID token without an explicit audience — the common `actions/oidc` + cloud-creds
  pattern — receives a token whose `aud` cannot be matched by any policy keyed on
  `scheme://host/owner`. One-character class of fix, high real-workflow impact.
- **Medium — the subject format differs.** Upstream: `repo:<OwnerName>@<OwnerID>/<Name>@<RepoID>`
  (`services/actions/oidc.go:173-177`). Ours interpolates the full name into the
  first segment: `repo:<OwnerName>/<Name>@<OwnerID>/<Name>@<RepoID>`
  (`oidc.ts:119`). GitHub-style consumers that pin the immutable subject — the
  exact purpose of the ID-bearing format — never match. Also `workflow` /
  `workflow_ref` legs are the staged fallbacks (path-for-name; parser M3) —
  documented, upstream's own fallback when the YAML has no name.
- **Info — `ref_protected` is always `"false"`** (SPEC-0013 lands at M3); upstream
  computes real branch-protection state (`services/actions/context.go:63-65,95`).
  Consumers gating cloud creds on `ref_protected` are safer (denied), not
  broken.
- **Nit — the runtime JWT spells the cache-scope claim `Ac`** where upstream's
  struct tag marshals `ac` (`services/actions/auth.go:29` vs `secrets.ts:385`).
  Self-consistent mint+verify today; an external cache service expecting
  upstream's spelling would not parse it. Same class: claim names `TaskID/RunID/
  JobID` intentionally match upstream's untagged Go field names.

## 9. What a real act_runner + real workflows hit first (ranked)

1. **OIDC default audience `https://hostowner` and the subject format** — every
   `permissions: id-token: write` workflow with an audience-keyed consumer fails
   verification or policy matching (§8).
2. **Org-runner FetchTask 500s once the org passes ~95 actions-enabled repos** —
   the runner flaps offline and the fleet stops picking up work (§2).
3. **Missing endless/abandoned sweeps + zombie FAILURE-on-cancelling** — hung
   tasks run forever, unpicked jobs strand runs in RUNNING, and user-cancelled
   cleanup deaths record as failures (§5).
4. **Ephemeral-runner hygiene** — crashed ephemeral runners (and zombie-killed
   ones) accumulate on an unarmed deployment; their unsealed logs accumulate in
   D1 (§5, §6).
5. **No default retention** — a Gitea migrant expecting 90/365/400 day cleanup
   keeps everything forever unless they set the three vars (§5, deliberate).
6. **Cancelling-time UpdateTask result echo** — runner-version dependent, feeds
   `needs` result consumers through the same mapping (§3).

Everything else reviewed — the wire interceptors, token rotation, heartbeats,
dispatch ordering and version cascade, the terminal-state machine, the UpdateLog
ack/trim/resend/seal protocol, artifact upload/merge/signed-URL semantics, OIDC
discovery and exchange, and the job-summary endpoint — is behaviorally aligned
with the pin within the documented staged/plan divergences.

---

*Review scope note: this report documents only; no code or spec was modified.
File cites use `upstream-path:line` at pin fc493688 and
`apps/worker/src/...:line` at review time.*

# SPEC-0012: Gitea Actions protocol compatibility (self-hosted act_runner server surface) — feasibility, gated

Status: **draft — gated** (research-only; surface inventory at the pin verified in this
document. NOTHING in it is built until the §1.1 entry criteria fire — same discipline
as SPEC-0010's pre-ratification shape and SPEC-0011's gated ratification) ·
Date: 2026-10-24 · Fills the ADR-0001 deferred item "Gitea Actions compat"
(`docs/decisions/0001-technical-direction.md:126-127`, still listed as out of scope
at ADR-0001:128-130).
Depends on: SPEC-0002 (auth semantics), SPEC-0004 (API conventions + contract
discipline), SPEC-0005 (push/create/delete family through the engine `onPush` seam),
SPEC-0006 (R2 relay/presign precedent for chunked blob upload).
Owns: the `/api/actions` runner protocol surface, the `/api/actions_pipeline` artifacts
v1 family, the `/twirp/...ArtifactService` v4 family, the Actions OIDC token endpoint,
job-summary upload, the workflow trigger chain (server-side YAML parsing), and the
Actions D1 schema (runs, jobs, tasks, runners, runner tokens, secrets/variables).

Upstream findings are against the vendored submodule (`gitea/`, read-only, pin
`v1.22.0-rc1-3919-gfc493688` / `fc49368845`). Landed-code findings are against
`apps/worker/**` as of 2026-10-24.

## 1. Problem and scope

ADR-0001 D2 makes cf-gitea a headless Gitea whose Tier-1 contract serves "CLI tools,
release tooling, CI, Gitea-API SDKs" (`docs/decisions/0001-technical-direction.md:72-75`).
The one Tier-1 client class cf-gitea cannot serve today is CI: a user who pushes
`.gitea/workflows/*.yml` gets a repo that silently ignores them. Gitea's answer is
Gitea Actions: the server stores runs/jobs/logs/artifacts and matches workflows to
events, while a **self-hosted `act_runner`** polls the server, claims jobs, executes
them (containers are the runner's problem), and streams results back. The protocol
boundary is exactly the surface a Workers reimplementation must speak.

**Proposed compatibility level:** a stock, unmodified `act_runner` can (a) register
against cf-gitea, (b) long-poll for and claim jobs, (c) stream logs, (d) upload and
download artifacts, (e) mint OIDC tokens, and (f) post job summaries — while cf-gitea
parses workflow YAML server-side **only where the trigger chain and API/UI surface
need it**. We do not execute any workflow step server-side; the runner does.

### 1.1 Entry-criteria decision (the gate on this SPEC)

**Decision: implement when a concrete CI demand exists against a deployed cf-gitea
instance; until then this SPEC stays `draft` and nothing in it is built.**

The implementation window opens when ALL of:

1. **Demand** — a concrete user/project requirement that a real repository hosted on
   cf-gitea runs CI (upstream parity for its own sake is explicitly not demand;
   SPEC-0010 §1.1's rationale applies verbatim: the correct resting state of a
   demand-shaped feature is `draft`).
2. **A runner operator** — someone committed to operating at least one self-hosted
   act_runner against that instance (Actions is useless without one; the runner is
   an external binary — the pinned submodule contains no runner execution code, only
   the server side, and the wire contracts live in an external module, `gitea/go.mod:11`
   `gitea.dev/actionslib v1.5.0`).
3. **A wire capture** — before M1 lands, a capture of a real act_runner session
   against a reference Gitea instance at (or near) the pin, to freeze: the connect
   protocol variant the runner actually speaks, the exact service procedure names
   (§2.2), and the codec. In-tree evidence says the endpoints are connect-RPC
   procedure mounts (`gitea/routers/api/actions/runner/runner.go:30-37`), but the
   generated `runnerv1connect.RunnerServiceName` string and the proto codec bytes are
   defined in the external actionslib module, which is not vendored — we will not
   guess them (GATE: no invented upstream behavior).

Rationale (recorded so the gate survives personnel changes): Actions is the largest
single compat surface after the web UI — the server-side slice measured in §2 spans
~25 event hooks, five runner RPCs, three artifact protocols, an OIDC issuer, and a
job-dependency state machine. Building it speculatively spends the platform's scarcest
budget (review + wave slots) on surface nobody may poll. When the gate fires, this
SPEC is reviewed, ratified to `accepted`, and implemented milestone by milestone (§5).

### 1.2 In scope (when the gate opens)

1. The runner protocol: ping + Register/Declare/FetchTask/UpdateTask/UpdateLog (§2.2).
2. Artifacts v1 (`/api/actions_pipeline/_apis/pipelines/...`) and v4
   (`/twirp/github.actions.results.api.v1.ArtifactService/...`) on R2 (§2.3–2.4, §4.2).
3. Job-summary upload (§2.5) and the Actions OIDC issuer (§2.6).
4. The trigger chain: push/branch-create/delete events → workflow match → run/job
   rows → commit statuses → task claim (§3.1, §4.5).
5. Log ingest + storage + the `/api/v1` logs-download endpoint (§4.3).
6. The registry-management `/api/v1` additions Actions requires: runner registration
   tokens, runners CRUD, secrets/variables, runs/jobs listing (§2.7).
7. D1 schema for the above + retention/cleanup jobs (§3.6).

### 1.3 Out of scope (v1, and §5 lists what stays out even later)

- **Executing steps**: containers, node runtimes, action checkout/download — act_runner
  owns all of it. The server never runs user code; its only execution-adjacent job is
  handing the runner a single-job YAML payload at claim time (§3.2).
- Marketplace/action hosting beyond answering the checkout-shim question (§6 OQ-4).
- Tier-2 Actions UI pages (runs list, run viewer, runners admin — `gitea/routers/web/web.go:1567-1589`,
  `508-513`, artifact preview `web.go:293`).
- Scheduled (`on: schedule`) workflows in v1 (§4.5 note); scoped workflows
  (`modules/actions/scoped_workflows.go`) and reusable-workflow call expansion in v1
  (upstream: `services/actions/reusable_workflow.go`, 562 lines) — v2.

## 2. Surface inventory at the pin

### 2.1 Mount points

`routers/init.go:196-206`, gated on `setting.Actions.Enabled` (`init.go:196`):

- `POST|GET /api/actions/*` — `actions_router.Routes(prefix)` (`init.go:197-198`):
  OIDC group (`routers/api/actions/actions.go:16-20`), ping (`actions.go:22-23`),
  runner service (`actions.go:25-26`). Handler mounts strip the prefix and serve
  connect-RPC procedures under `/<service-name>/` (`ping/ping.go:24`,
  `runner/runner.go:36`).
- `/api/actions_pipeline/*` — artifacts v1 + job summaries (`init.go:203-204`,
  route table `routers/api/actions/artifacts.go:108-131`).
- `/twirp/github.actions.results.api.v1.ArtifactService` — artifacts v4
  (`init.go:205-206`; route base const `routers/api/actions/artifactsv4.go:124`).

Upstream's own comment on the pipeline prefix: "TODO: Pipeline api used for runner
internal communication with gitea server. but only artifact is used for now"
(`init.go:201-202`).

### 2.2 Runner protocol (connect-RPC, five procedures)

Auth: every procedure except `Register` requires the runner's UUID + token headers
(`interceptor.go:46-68`: `protocol.UUIDHeader`/`TokenHeader` at `:26-29`, lookup by
UUID `:59`, constant-time hash compare `:97-107`); `Register` bypasses auth
(`interceptor.go:51-53`). The interceptor also debounces `last_active`/`last_online`
DB writes to avoid write-per-poll load (`interceptor.go:70-90`).

| Procedure | Handler | Wire-relevant facts at the pin |
|---|---|---|
| `Register` | `runner/runner.go:44-114` | Body carries a one-time registration token (`GetRunnerToken` `:52`), name, labels, version, `Ephemeral`, capabilities (`:73-87`); token is single-use — flipped inactive on success (`:96-98`). Registration tokens are scoped global/org/repo (`models/actions/runner_token.go:21-29`). Advertised capability string `cancelling` (`runner.go:119`). |
| `Declare` | `runner.go:142-165` | Periodic re-label/version; server replies with feature negotiation via the `X-Gitea-Actions-Capabilities` response header (`runner.go:151-154`). |
| `FetchTask` | `runner.go:168-217` | **Not a server-held long poll** — the runner polls, the server answers immediately with a task or empty + a `tasksVersion` counter (`:175-217`). Task pick is throttled per-process (`MAX_CONCURRENT_TASK_PICKS`, `services/actions/task.go:43-53`; setting at `modules/setting/actions.go:43-47`); a throttled runner "will retry on its next poll" (`runner.go:202-207`). Version bump semantics at `models/actions/tasks_version.go:31-75`. |
| `UpdateTask` | `runner.go:220-285` | State machine update (`UpdateTaskByState` `models/actions/task.go:481`), job outputs (key ≤255 B, value ≤1 MiB, `runner.go:232-249`), commit status refresh (`:263`), downstream job emission (`:270-276`). |
| `UpdateLog` | `runner.go:288-359` | Rows + ack-index protocol; runner "sends all pending log rows in one UpdateLog" so the server keeps unlimited read size (`runner.go:34-35`, `WithReadMaxBytes(0)`); finalize (`NoMore`) seals the log and transfers it to storage (`:343-349`); re-sent finalize is idempotent, appends past the seal error (`:311-317`). |

Wire format: connect handlers accept connect/gRPC/gRPC-Web (`connecthttp.Mount`,
`runner.go:35`); the runner's actual protocol+codec is OQ-1 (§6) pending the wire
capture. Service name strings come from the external actionslib module (`go.mod:11`);
in-tree procedure-name evidence: `Register` (`interceptor.go:52`),
`UpdateTask`/`UpdateLog` (`interceptor.go:75`), the generated client interface
assertion (`runner.go:39`).

### 2.3 Artifacts v1 (`/api/actions_pipeline/_apis/pipelines/workflows/{run_id}/artifacts`)

Auth: `Authorization: Bearer <ACTIONS_RUNTIME_TOKEN>` — a per-task HS256 JWT
(`artifacts.go:146-155`; claims/shape `services/actions/auth.go:43-70`, scoped
`Actions.Results:{runID}:{jobID}` at `:55`); legacy runners use the raw task token
(`artifacts.go:170-180`, `models/actions/task.go:187`). Run-id must match the token's
job (`artifacts_utils.go:35-44`).

Protocol (documented verbatim in `artifacts.go:6-61`):

1. `POST .../artifacts` → upload URL keyed by `md5(name)` (`artifacts.go:119, 237`);
   `?retentionDays=` rides the returned URL (`artifacts.go:232-234`).
2. `PUT .../{artifact_hash}/upload` — chunked, headers `x-tfs-filelength`,
   `x-actions-results-md5`, `content-range: bytes s-e/total`
   (`artifacts.go:121`; header consts `artifacts_utils.go:18-21`; chunk save with
   streamed md5 verification `artifacts_chunks.go:75-125`).
3. `PATCH .../upload` — confirm; server merges chunks in order into one stored
   object (`artifacts.go:119`; merge `artifacts_chunks.go:260-296, 311-399`: ordered
   MultiReader → single `Save`, optional sha256 verification `:350-387`).
4. `GET .../artifacts` (list), `GET .../{artifact_hash}/download_url`,
   `GET .../{artifact_id}/download` (`artifacts.go:119-124`).

### 2.4 Artifacts v4 (twirp-style, the modern toolkit path)

Routes (`artifactsv4.go:140-161`): `POST CreateArtifact | FinalizeArtifact |
ListArtifacts | GetSignedArtifactURL | DeleteArtifact` (`:149-153`), `PUT
UploadArtifact` and `GET DownloadArtifact` on HMAC-signed URLs (`:156-157`). Bodies
are protojson (`parseProtobufBody` `:298-316`), capped at 1 MiB (`maxProtobufBodySize`
`:296`) — only the upload/download URLs carry bulk bytes. Signed URLs: HMAC-SHA256
over (tag, endpoint, expires, artifactName, taskID, artifactID) with the general
token-signing secret (`modules/actions/artifacts.go:19-29`), 60-minute expiry
(`artifactsv4.go:168`), verified at `artifactsv4.go:217-261`. Upload semantics:
`?comp=block|appendBlock|blocklist` — Azure-Blob-flavored block upload with an XML
blocklist naming the final block order (`artifactsv4.go:404-456`, `BlockList` XML
`:458-460`, ordered replay `artifacts_chunks.go:186-258`).

### 2.5 Job summaries (`GITHUB_STEP_SUMMARY`)

`PUT /api/actions_pipeline/_apis/pipelines/workflows/{run_id}/jobs/{job_id}/steps/{step_index}/summary`
(route base `job_summary.go:19`, table `artifacts.go:128`). Validates the job and
step index against the task (`job_summary.go:27-47`), markdown-only content type
(`:91-104`), empty body clears (`:62-69`), per-step cap 1 MiB
(`models/actions/run_job_summary.go:22-23`) with an aggregate cap error path
(`job_summary.go:71-74`).

### 2.6 Actions OIDC issuer

Three GETs under `/api/actions/oidc` (`actions.go:16-20`):

- `/.well-known/openid-configuration` — issuer = `<AppURL>api/actions/oidc`
  (`services/actions/oidc.go:102-104`), discovery doc `routers/api/actions/oidc.go:17-28`.
- `/jwks` — RS256 public key (`services/actions/oidc.go:33`; key lazily
  created/persisted at `<AppDataPath>/jwt/actions_oidc.pem` `:41-54`).
- `/token` — **token exchange, not OAuth2**: bearer = a short-scoped
  `Actions.IDTokenRequest` JWT minted for the task when the workflow declares
  `id-token: write` (`services/actions/auth.go:20`, minted in
  `services/actions/task.go:203-212`), + `?audience=`; verifies the task is running
  and permitted (`services/actions/oidc.go:115-139`), returns `{value: <id_token>}`.

ID-token claims mirror GitHub's (`services/actions/oidc.go:56-82`): immutable-ID
subject `repo:<owner>@<ownerID>/<repo>@<repoID>...` (`:172-178`), 5-minute expiry with
5-minute not-before backdating (`:193-194`), `runner_environment: "self-hosted"`
(`:221`). Signing: RS256 over a persisted PEM — on Workers this becomes a
generated-and-stored keypair (§4.6).

### 2.7 The `/api/v1` surface Actions adds

Registration shared by repo/org/user scopes via `addActionsRoutes`
(`routers/api/v1/api.go:964-996`): secrets (`:968-972`), variables (`:974-982`),
runners incl. `POST /actions/runners/registration-token` (`:984-990`), runs/jobs
listing (`:992-993`). Repo-level additionally: workflows list/get/runs/enable/disable/
`POST dispatches` (`:1255-1263`) and `GET /actions/jobs/{job_id}/logs` (`:1264-1267`).
User-level mirror at `:1112-1133`. These are ordinary JSON APIs — no new machinery,
but they are the registration-token mint the runner protocol consumes (§2.2).

## 3. Division of labor: what the server provides vs what act_runner owns

### 3.1 Server-side: trigger → run → job rows → claim

The Actions notifier implements the `notify_service.Notifier` interface — ~25 hooks
(`services/actions/notifier.go:33-36`): issues/labels/milestones/comments
(`:41-306`), PRs (`:355-424, 467-500`), push/create/delete (`:541, 573, 591`),
releases (`:645-661`), packages (`:664-671`). Each hook builds a webhook payload and
calls `notify` (`notifier_helper.go:136`), which: opens the repo at the pushed commit,
`DetectWorkflows` (`notifier_helper.go:205` → `modules/actions/workflows.go:180-240`),
schedules or inserts runs (`buildApproveAndInsertRun` `notifier_helper.go:376`,
`InsertRun` `services/actions/run.go:63`), and posts skipped-run commit statuses for
path/branch-filtered workflows (`handleFilteredWorkflows` `notifier_helper.go:442`).

Workflow matching lives in `modules/actions/workflows.go`: workflow files are
`.yml`/`.yaml` under `.gitea/workflows` + `.github/workflows`
(`modules/setting/actions.go:52`; `IsWorkflow` `workflows.go:53-73`), enumerated
recursively from the commit tree (`ListWorkflows` `workflows.go:75-108`), read with a
**1 MiB per-file cap** (`GetContentFromEntry` `workflows.go:110-121`, cap at `:115`),
events extracted per file (`GetEventsFromContent` `:123-126`), then matched per event
— push matching incl. branch filters/paths-ignore (`matchPushEvent` `workflows.go:390`),
plus issue/PR/release/package/workflow_run matchers (`workflows.go:499-898`).
`[skip ci]`-family suppression (`skipWorkflows` `notifier_helper.go:298`; strings at
`modules/setting/actions.go:51`).

Parsing leans on the external actionslib module: `jobparser` imports
`actionslib/pkg/{expreval,exprparser,model}` (`modules/actions/jobparser/jobparser.go:12-14`)
— i.e. the workflow schema model AND the GitHub-expression evaluator are external Go,
not vendored. **This is the single largest port cost** (§5 M2).

Job graph: after insert and after every task completion the job emitter re-resolves
`needs`/`if`/concurrency (`EmitJobsIfReadyByRun` `services/actions/job_emitter.go:31`,
resolver `:489-548`, run-level concurrency `:183`, wake propagation `:154`), expands
deferred matrices (`services/actions/matrix.go:43`, bounded by `MaxJobNumPerRun = 256`
`models/actions/run_job.go:29`). Note the server (not the runner) evaluates job-level
`if:` and concurrency expressions — expression evaluation is server work (§4.5 budget).

Task claim: `FetchTask` → `TryPickTask` → `CreateTaskForRunner`
(`models/actions/task.go:265-327`): keyset-paginated scan of waiting jobs
(`pickTaskBatchSize = 100` `:259`), label intersection (`CanMatchLabels` call `:310`),
then an atomic optimistic-lock claim (`claimJobForRunner` `:333-414`; the
`task_id = 0 AND status = waiting` guard `:392-400`); a failed assembly releases the
claim (`ReleaseTaskForRunner` `:420-451`).

### 3.2 What the server hands the runner at claim time

`buildRunnerTask` (`services/actions/task.go:135-174`) returns: the single-job
re-serialized workflow payload with `if:` forced to `always()` (the server already
decided; the runner must not re-evaluate — `runnerWorkflowPayload` `:176-187`), the
`github`/`gitea` context struct (`generateTaskContext` `:189-215`, built by
`GenerateGiteaContext` `services/actions/context.go`), the `token` +
`gitea_runtime_token` (`:201-202`), OIDC request URL+token when permitted
(`:203-212`), task secrets (`:141`), repo/org/global variables (`:146`), and the
resolved outputs of `needs` (`findTaskNeeds` `:217-230`).

### 3.3 Runner-side (external act_runner — none of it lands in this repo)

The runner: clones the repo itself using the handed token; downloads `uses:` actions
from the internet (GitHub by default — `DefaultActionsURL` setting,
`modules/setting/actions.go:46, defaultActionsURLGitHub`); provisions containers or
the host environment; executes steps; evaluates step-level expressions; batches logs
into `UpdateLog` rows; uploads artifacts via §2.3/§2.4; calls the OIDC endpoint. The
server's only real-time involvement is being polled. (The pinned tree has no runner
execution code anywhere — the only "runner" code is the protocol server of §2.2.)

### 3.4 The webhook/notify surface Actions adds

Beyond the notifier hooks above (§3.1), Actions contributes: commit-status publication
for jobs — context `"<workflow> / <job> (<event>)"` (`modules/actions/workflows.go:158-165`),
posted for push/PR/release-family events (`ShouldEventCreateCommitStatus`
`workflows.go:172-178`) via `CreateCommitStatusForRunJobs`
(`services/actions/commit_status.go:31`); internal status-update notifications
(`NotifyWorkflow*` family `services/actions/notify.go:16-133`); and the cancel/
timeout machinery (`StopTask` `models/actions/task.go:568`; zombie/endless/abandoned
timeouts `modules/setting/actions.go:138-140`).

## 4. Workers capability mapping

### 4.1 Runner polling — fits request/response natively

The runner polls US; nothing needs us to hold sockets open. In-tree evidence that
upstream's FetchTask is answer-immediately (`runner.go:202-207` "it will retry on its
next poll"; `interceptor.go:80-84` warns about write load "on every poll" — i.e. polls
are frequent, short requests). A Hono route answering FetchTask from D1 is the same
shape as our existing API routes. No DO, no websockets, no event consumers on the hot
path. The `X-Gitea-Actions-Capabilities` header and uuid/token headers are plain HTTP
headers (§2.2).

### 4.2 Artifacts on R2

Layout proposal (mirrors the LFS prefix precedent, `services/lfs/store.ts:78`):

```
actions/tmp/<run_id>/v3/<run>-<artifact>-<start>-<end>.chunk     # v1 chunks (name format upstream, artifacts_chunks.go:41-47)
actions/tmp/<run_id>/v4/block-<run>-<artifact>-<size>-<b64blockid>  # v4 blocks (artifactsv4.go:179-182)
actions/tmp/<run_id>/v4/<run>-<artifact>-blocklist               # XML blocklist (artifactsv4.go:448)
actions/artifacts/<run_id>/<artifact_id>/<attempt>-<ts>          # merged object (generateArtifactStoragePath analog, artifacts_chunks.go:298-307)
```

- **Chunk ingest** is a streaming R2 PUT per request — no memory scaling (AGENTS.md:155
  stream-don't-buffer; the Workers isolate memory cap is 128 MiB, so buffering even a
  4 MiB-class artifact would be fine but buffering a 10 GiB one is impossible; every
  path below streams).
- **The merge is the hard part**: upstream merges by re-reading chunks in order
  through an in-process MultiReader (`artifacts_chunks.go:333-349`). R2 has no server-side
  concatenation and no append (the same gap SPEC-0001a recorded for copies —
  workerd#1349, `docs/decisions/0001-technical-direction.md:199`).
  Proposal: stream-merge inside ONE request — open chunk objects sequentially and pipe
  them into a single R2 multipart upload, part by part (flat memory; wall time is R2
  throughput, which is free — HTTP wall time is unbounded while the client stays
  connected, AGENTS.md:163-165; only CPU counts, and piping is near-zero CPU). Cap
  per-merge wall time by chunk count via a queue consumer for very large artifacts if
  the request budget proves tight (OQ-3).
- **Size caps**: upstream has no hard artifact size cap in code — the effective caps
  are config retention (default 90 days, `modules/setting/actions.go:19, 32, 58`) and
  storage. We propose an explicit quota per run (product decision, OQ-5) plus the
  existing 1 MiB proto/summary caps verbatim (§2.4, §2.5).
- v4 signed URLs map cleanly onto our own HMAC scheme — same construction as upstream
  (`modules/actions/artifacts.go:19-29`), and SPEC-0006's relay/presign duality
  (`services/lfs/router.ts:375`) is the precedent for serving downloads.

### 4.3 Log streaming

Upstream appends rows to a DBFS file (row format `"<RFC3339-time> <content>"`,
`modules/actions/log.go:24-30`; append API `WriteLogs` `:35-78`, explicitly chosen
"because it's not efficient to append content to object storage" `:32-34`), then
seals it into object storage with zstd 128 KiB blocks on `NoMore`
(`TransferLogs` `:126-129`; block-size rationale `:114-119`). Rows are ≤64 KiB
(`MaxLineSize` `:25`).

Workers options, in preference order:

1. **D1-held active rows + R2 sealed object** (proposed): while a task runs, `UpdateLog`
   appends row batches to a D1 `action_task_logs` table (upstream keeps the same data
   hot in DBFS); on `NoMore` a `ctx.waitUntil`/queue job streams rows into one R2
   object (optionally zstd) and flips `log_in_storage` (upstream column parity,
   `runner.go:351`). Reads (UI/API `GET /actions/jobs/{id}/logs`, §2.7) hit D1 hot or
   R2 sealed. This keeps the runner protocol's ack-index semantics byte-identical.
2. A per-task DO holding the live log stream (append-friendly), sealed to R2. Rejected
   for v1: adds a DO class + migration for state D1 already models, and the write rate
   (rows per second per running task, `interceptor.go:72-75` notes UpdateLog can fire
   many times per second) is D1-appropriate at hobby scale.

### 4.4 Job queue & scheduling

Upstream's queue is D1: waiting jobs are rows (`FindJobQueueJobs`
`models/actions/run_job_queue.go:59`, ordered oldest-first `:54`), claiming is a
conditional UPDATE CAS (`task.go:392-400`), and the runner's poll is the dequeue
trigger. **D1 alone is the right v1 design** — no Queues, no DO needed for the claim
itself; the claim race is a single conditional UPDATE, exactly the D1+Drizzle pattern
the repo already uses. Where Cloudflare Queues DO join: (a) kicking the job emitter
after `UpdateTask` (needs-graph re-resolution is a bounded D1 transaction — upstream
runs it inline, `runner.go:270-276`; we can too, falling back to enqueue if the
transaction grows), and (b) retention/cleanup sweeps riding the existing `repo-tasks`
consumer (wrangler.jsonc:105, dispatch `apps/worker/src/index.ts:125`). Cron: the
existing `*/10` trigger (wrangler.jsonc:92) already proves the sub-hour cadence;
schedule workflows are a v2 add-on riding the same producer pattern (§1.3).

### 4.5 The trigger chain — our landed onPush seam

The push half of upstream's ~25 notifier hooks is the v1 wedge:

```
engine receive finalize
  → onPush seam (apps/worker/src/index.ts:29, wired :42; adapter
    handleUserPushEvent apps/worker/src/services/webhooks-push.ts:465)
  → [NEW, queue consumer] resolve commit tree from RepoCell → list workflow files
    → parse YAML → match on: push (branches/paths filters) → insert run + job rows
    (D1) → post commit statuses (POST /repos/{owner}/{repo}/statuses/{sha} service
    already exists: apps/worker/src/api/routes/statuses.ts:110-114, mounted
    apps/worker/src/api/router.ts:48)
```

`emitPushFamilyUpdates` already fans out per-ref from the same seam
(`services/webhooks-push.ts:220, 441`); the Actions consumer joins it as one more
fan-out leg — but parse+match must NOT run inline in `waitUntil` (30 s hard cap,
AGENTS.md:166-167): it enqueues a `repo-tasks` message (the pattern SPEC-0009's sync
notifications already use, `specs/README.md:39`).

**CPU/time budget for workflow parsing** (the real constraint): per pushed ref, cost
is O(files × parse). Upstream caps each file at 1 MiB (`workflows.go:115`) and skips
non-`.yml`/`.yaml` paths (`workflows.go:62-63`); the D1-free path is: engine tree
list (one RPC) + per-file blob read (one RPC each — batchable) + YAML parse. A
10-workflow repo at ~50 KB average is ~500 KB of YAML; a JS YAML parse of that is
milliseconds-to-tens-of-ms of CPU — comfortably inside `limits.cpu_ms: 300000`
(wrangler.jsonc:11) per request. The budget risk is not per-request CPU but **port
fidelity of the parser itself** (matrix expansion, expression subset used by `if:` —
server-side per §3.1; OQ-2).

### 4.6 Auth & keys

- Runtime JWT (artifacts/auth): HS256 with a server-wide signing secret
  (`services/actions/auth.go:63-70`) → one Worker secret (`wrangler secret`),
  replacing upstream's `GetGeneralTokenSigningSecret`.
- OIDC signing key: upstream persists an RS256 PEM on disk
  (`services/actions/oidc.go:41-54`). Workers equivalent: generate once, store the
  private key in D1 (encrypted with the existing AES pattern, SPEC-0009 §4.2
  precedent) or derive from a secret; publish the JWK at `/jwks`. Web Crypto supports
  RS256 sign/verify natively.
- Runner tokens: upstream stores salt+hash (`interceptor.go:97-107`,
  `auth_model.HashToken`) — identical to SPEC-0002's SHA-256-digest token model
  (ADR-0001 D3, `docs/decisions/0001-technical-direction.md:82`).

### 4.7 Schema

New D1 tables (one migration family, Drizzle per AGENTS.md:38-39): `action_runners`,
`action_runner_tokens`, `action_runs`, `action_run_jobs`, `action_tasks`,
`action_task_steps`, `action_task_outputs`, `action_task_logs` (v1-deviation, §4.3),
`action_artifacts`, `action_run_job_summaries`, `action_secrets`, `action_variables`
— column-for-column ports of `gitea/models/actions/{runner,run,run_job,task,
task_step,task_output,artifact,run_job_summary,variable}.go` minus upstream's ORM
plumbing, plus the tasks-version counter (`models/actions/tasks_version.go`).

## 5. Milestones, effort, and what stays out

Effort is in **wave units** — one wave ≈ one background-agent landing unit with review
(AGENTS.md pool discipline, AGENTS.md:91-108). Estimates are honest first-passes with
the uncertainty source named; they assume the §1.1 wire capture has happened.

| # | Milestone | Content | Est. | Why |
|---|---|---|---|---|
| M0 | Wire-capture freeze | Capture act_runner ↔ reference Gitea; pin protocol variant, procedure names, codec; record in this SPEC | 0.5 | External tooling only, no repo code |
| M1 | Schema + runner protocol | D1 tables; connect-RPC-compatible codec (hand-rolled or a protobuf lib — OQ-1); Register/Declare/FetchTask/UpdateTask; ping | 2 | New wire machinery; codec risk is the unknown |
| M2 | Trigger chain | YAML model + `on:` push matching + matrix expansion + job `if:`/needs resolver (TS port of the actionslib model subset, §3.1); onPush consumer; commit statuses | 3 | Largest port surface; expression evaluation fidelity (OQ-2) |
| M3 | Claim + state machine | `CreateTaskForRunner` CAS port, tasks_version, UpdateTask outputs, job emitter v1 (needs graph, serial-first), timeouts/cancel | 2 | Concurrency subtleties; emitter is 718 lines upstream |
| M4 | Logs | UpdateLog ack protocol, D1 hot rows, seal→R2, jobs/{id}/logs endpoint | 1 | Protocol simple; storage choice settled (§4.3) |
| M5 | Artifacts v4 + v1 | Signed URLs, block upload, streaming merge to R2, download, delete; v1 family for old runners | 2 | Merge choreography (§4.2); v1 is mostly mechanical once v4 lands |
| M6 | Registry APIs + OIDC + summaries + retention | §2.7 v1 additions; RS256 issuer; job summaries; cleanup sweeps; swagger contract entries | 1.5 | Broad but shallow; rides existing patterns |

**Total: ~12 waves** (M0 0.5 + 11.5 implementation). For calibration: SPEC-0009
(mirrors+import) landed end-to-end across roughly a comparable multi-wave arc
(`specs/README.md:39`). Items that could blow the estimate: expression-evaluation
fidelity (M2), and v1-artifacts-era runner compatibility (dropped if OQ-1 says modern
runners only speak v4 — saves ~0.5 wave).

**Deliberately NOT built in v1** (and gated even later unless a demand arrives):
marketplace/self-hosted action hosting beyond documenting that runners check out
actions from GitHub by default (`modules/setting/actions.go:46`) — the "checkout shim"
(question: do we ever need to proxy/cache `uses:` downloads; answer deferred, OQ-4);
container orchestration of any kind (the runner owns containers, §3.3); Actions UI
pages (§1.3); scheduled workflows; scoped + reusable workflows; packages triggers;
workflow_dispatch beyond the API endpoint if trivial (§2.7), else v2.

## 6. Open questions

- **OQ-1 (gating M1)**: Which connect protocol variant + codec does act_runner
  actually emit (connect-proto vs gRPC), and what are the exact service/procedure
  name strings? Answered by the M0 wire capture; the submodule does not contain them
  (external module, `gitea/go.mod:11`).
- **OQ-2 (M2 scope)**: Which expression subset must the server evaluate? Upstream
  evaluates job-level `if:`, concurrency groups, and matrix (§3.1) — full GitHub
  expressions live in actionslib's evaluator. Candidate simplification: v1 supports
  literal/needs-result conditions only and rejects workflows using richer expressions
  at insert time (visible error instead of silent mismatch). Decide at ratification.
- **OQ-3 (M5)**: Streaming merge wall time for multi-GiB artifacts — does the
  request-path merge hold, or do very large finalizes move to the `repo-tasks`
  consumer? Instrument at M5; the CPU ceiling is not the constraint (§4.2).
- **OQ-4 (product)**: Checkout shim for `uses:` actions — GitHub-hosted default
  (`modules/setting/actions.go:46`) means runners need general internet egress; a
  future self-hosted actions proxy is a separate SPEC if anyone asks.
- **OQ-5 (product)**: Per-run artifact/log quota numbers (upstream: retention 90/365/
  400 days, `modules/setting/actions.go:19-21`; no size cap in code). Propose
  matching retention defaults, plus an explicit size quota to protect R2 spend.
- **OQ-6 (D1)**: Row-cost of `action_task_steps`/logs at hobby scale — upstream
  inserts one step row per workflow step (`task.go:374-389`) and debounce logic
  exists precisely because log writes are hot (`interceptor.go:70-79`). Re-check
  D1 write pricing against the ADR-0001 annex cost model before ratification.

## 7. Testing plan (when ratified)

- **Contract**: the runner protocol and artifacts families are outside
  `/api/v1`'s swagger, so they get their own contract fixture: recorded M0 wire
  captures replayed against our routes (byte-level for codec paths) — the
  flare-forge discipline ADR-0001 D3 applies (`docs/decisions/0001-technical-direction.md:89-90`).
- **Unit**: workflow matchers differential-tested against upstream Go behavior via a
  table of recorded input/output pairs (the SPEC-0001b diff3 precedent, ADR-0001
  annex `docs/decisions/0001-technical-direction.md:191-192`); claim-CAS races under
  vitest-pool-workers real D1 (SPEC-0005's consumer-test pattern,
  `apps/worker/src/webhooks/consumer.test.ts` exists as the template).
- **E2E**: a real act_runner binary against local workerd, running a trivial
  workflow (echo → upload artifact → download → assert), plus log ack/resume and
  OIDC mint-and-verify. This is the acceptance bar: unmodified runner, green suite.

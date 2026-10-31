# SPEC-0012: Gitea Actions — the upstream-parity control plane (runner protocol, artifacts, registry APIs, UI family), the trigger chain staged behind the expression-evaluator question

Status: **accepted** (rewrite of the 2026-10-24 gated feasibility draft; the gate is
LIFTED by the Upstream-Parity Decision Rule, AGENTS.md:248-257, learned 2026-10-29 —
see §1.1) · Date: 2026-10-29 · Fills the ADR-0001 deferred item "Gitea Actions
compat" (`docs/decisions/0001-technical-direction.md:126-127`, still listed as out
of scope at ADR-0001:128-130).
Depends on: SPEC-0002 (auth semantics — token digests, the scope grammar),
SPEC-0004 (API conventions + contract discipline), SPEC-0005 (the push/create
family through the engine `onPush` seam — the trigger chain's entry), SPEC-0006
(R2 key-namespace + presign/relay precedent), SPEC-0009 (the cron-producer →
serialized queue-consumer idiom), SPEC-0013 (protected branches — the
required-check globs the skipped-status arm consults), SPEC-0016 (the R04/R16
house staging idiom this SPEC mirrors).
Owns: the `/api/actions` runner protocol surface, the `/api/actions_pipeline`
artifacts-v1 family, the `/twirp/...ArtifactService` v4 family, the Actions OIDC
issuer, job-summary upload, the Actions D1 schema (runners, registration tokens,
runs, jobs, attempts, tasks, steps, outputs, tasks-version, artifacts, summaries —
secrets and variables ALREADY EXIST, §4.1), the `/api/v1` registry-management
additions, the Actions UI page family, and the M3 trigger chain (workflow
detection → run/job rows → commit statuses → dispatch), staged behind Open
question 1.

Upstream findings are against the vendored submodule (`gitea/`, READ-ONLY, pin
`fc4936884584` — describe `v29.0.0-dev-208-gfc49368845`; the 2026-10-24 draft's
"v1.22.0-rc1-3919" label was stale, the commit hash is identical). Cite
convention (the SPEC-0016 idiom): bare `file.go:N` cites resolve inside the
Actions packages — `gitea/routers/api/actions/`, `gitea/models/actions/`,
`gitea/services/actions/`, `gitea/modules/actions/`, `gitea/modules/setting/` —
and same-basename files (`runner.go`, `task.go`, `oidc.go`, `run.go`) are
prefixed with their parent directory wherever the section's first mention does
not already disambiguate them. Our-substrate findings are against
`apps/worker/**` and `apps/worker/wrangler.jsonc.example` as of 2026-10-29.

---

## 1. Problem and scope

### 1.1 The posture: parity, not feasibility (the gate is lifted)

The 2026-10-24 draft gated this SPEC on "a concrete CI demand" plus three entry
criteria. That gate misread upstream's architecture as a decision we had to make.
Upstream Gitea's own design puts **execution outside the server**: the pinned
submodule contains no workflow-execution code anywhere — the only "runner" code
in-tree is the protocol server (`routers/api/actions/`), and execution belongs to
the external `act_runner` binary. The server-side slice — registration, dispatch,
log/artifact ingestion, OIDC, the registry APIs, the UI — is therefore **pure
parity work with nothing to decide**, and per the Upstream-Parity Decision Rule
(AGENTS.md:248-257, recorded the same day as this rewrite) implementing it
faithfully is not a decision point. The gate is lifted; the demand criterion is
void.

What remains genuinely undecided is exactly one slice: **the trigger chain's
expression evaluation**. Upstream delegates the workflow schema model AND the
GitHub-expression evaluator to the external Go module `gitea.dev/actionslib
v1.5.0` (`gitea/go.mod:11`; imported by `modules/actions/jobparser/jobparser.go:12-14`)
— the server evaluates job-level `if:`, concurrency, and matrix expressions
itself (§2.9), so a faithful port needs a Go-expression evaluator on Workers
(Open question 1). The control plane (M1) does not depend on it: jobs can be
inserted by tests and the harness without the trigger chain, which is exactly how
upstream's own suites exercise the protocol.

### 1.2 The staged posture

- **M1 — the control plane (no decisions).** A stock, unmodified `act_runner`
  can register, poll, claim, stream logs, upload/download artifacts, mint OIDC
  tokens, and post step summaries against cf-gitea; the `/api/v1` registry family
  and the UI family land with it. Protocol truth comes from the in-tree handlers
  (§2) plus the hash-pinned actionslib proto retrieved at wire-freeze (§6.1) —
  no invented upstream behavior.
- **M2 — self-host docs.** A deployment guide for registering a real runner
  against a deployed instance (the README's self-host guarantee applies: we
  never execute user code; the operator's runner does).
- **The managed runner is explicitly OUT — a product question, not a milestone.**
  Hosting execution ourselves (Cloudflare-hosted runner fleet) has no upstream
  answer to copy, carries a cost/abuse profile this project does not want to
  default into, and stays out until someone with budget asks. It is recorded
  here ONLY so it is not silently re-decided (§1.4, §7).

### 1.3 In scope

1. The runner protocol: ping + the five `RunnerService` procedures (§2.2).
2. Artifacts v1 (`/api/actions_pipeline/_apis/pipelines/...`) and v4
   (`/twirp/github.actions.results.api.v1.ArtifactService/...`) on R2 (§2.4-2.5,
   §4.2).
3. Job-summary upload (§2.6) and the Actions OIDC issuer (§2.7).
4. The `/api/v1` registry family Actions adds: registration tokens, runners CRUD,
   secrets/variables (secrets/variables tables already exist, §4.1), runs/jobs
   listing, workflows enable/disable (§2.8).
5. The Actions D1 schema (§4.1) + retention/cleanup arms (§4.4).
6. The Actions UI page family (§2.10) — runs list, run viewer with the job log
   panel, runners/variables admin pages, artifact preview.
7. The trigger chain (M3, gated on Open question 1): push/branch-create/delete
   events → workflow detection → run/job rows → commit statuses → dispatch
   (§2.9).

### 1.4 Out of scope (v1, and what stays out even later)

- **Executing steps** — containers, node runtimes, action checkout/download:
  act_runner owns all of it. The server never runs user code; its only
  execution-adjacent job is handing the runner a single-job YAML payload at
  claim time (§2.3).
- **The managed runner** (§1.2) — product question, no milestone.
- **Marketplace/action hosting** beyond documenting that runners fetch `uses:`
  actions from GitHub by default (`modules/setting/actions.go:50,76-88`).
- **Scheduled (`on: schedule`) workflows** — the `action_schedule` +
  `action_schedule_spec` tables and the cron machinery
  (`services/actions/schedule_tasks.go`, 195 lines) stage as an M3 follow-up
  riding our existing cron entries; not in M1/M3's first cut.
- **Scoped workflows** (`modules/actions/scoped_workflows.go`,
  `action_scoped_workflow_source` table) and **reusable-workflow call expansion**
  (`services/actions/reusable_workflow.go`, 562 lines) — v2; the schema columns
  land with the model (they are NOT NULL DEFAULT 0/'' ports) but nothing reads
  them in v1.
- **Rerun/attempts > 1** — `services/actions/rerun.go` (685 lines) is v2; v1
  always has exactly one attempt row per run (attempt = 1), which the schema
  models naturally (§4.1).

## 2. The protocol surface (upstream at the pin)

### 2.1 Mount points

`routers/init.go:196-206`, gated on `setting.Actions.Enabled` (default **true**,
`modules/setting/actions.go:49`):

- `POST /api/actions/*` — `actions_router.Routes(prefix)` (`init.go:197-198`):
  the OIDC group (`routers/api/actions/actions.go:16-20`), the ping service
  (`actions.go:22-23`), and the runner service (`actions.go:25-26`). The ping and
  runner handlers are connect-RPC procedure mounts served under
  `/<service-name>/` after prefix-strip (`ping/ping.go:24`,
  `runner/runner.go:36`).
- `POST|GET|PUT|PATCH /api/actions_pipeline/*` — artifacts v1 + job summaries
  (`init.go:203-204`; route table `routers/api/actions/artifacts.go:107-130`).
  Upstream's own comment: "TODO: Pipeline api used for runner internal
  communication with gitea server. but only artifact is used for now"
  (`init.go:200-202`).
- `/twirp/github.actions.results.api.v1.ArtifactService` — artifacts v4
  (`init.go:205-206`; base const `artifactsv4.go:124`).

### 2.2 The runner RPC family (connect-RPC, five procedures + ping)

The wire contracts live in the external module `gitea.dev/actionslib v1.5.0`
(`go.mod:11`, go.sum-pinned `h1:dC3v2HTWbbvyNBSdg2W3kd4WNC/p+FnZaKpl1MdzM00=`):
`runnerv1` messages (`gitea.dev/actionslib/runner/v1`) + `runnerv1connect`
service name (`.../runner/v1/runnerv1connect`), `pingv1`
(`gitea.dev/actionslib/ping/v1`). The module is public on the Go module proxy —
M1a's wire-freeze fetches and hash-verifies it, then transcribes the `.proto`
files into the repo's contract fixtures (§6.1). Message shapes below are
reconstructed from the Go handlers' field usage; every field listed is
handler-touched, none invented.

**Auth interceptor** (`routers/api/actions/runner/interceptor.go`): every
procedure except `Register` requires the runner's UUID + token headers —
`protocol.UUIDHeader` / `protocol.TokenHeader` constants (`interceptor.go:26-29`,
values come from actionslib's protocol package; exact header strings transcribed
at wire-freeze). Lookup by UUID (`:59`), constant-time token-hash compare with an
LRU digest cache (`:97-107`). The interceptor also debounces `last_active` /
`last_online` DB writes — `ShouldPersistLastActive`/`ShouldPersistLastOnline`
(`models/actions/runner.go:89-99`) — because UpdateLog "fires many times per
second" and polls are frequent (`interceptor.go:72-84`). Plain errors reach
runners as connect `CodeUnknown` with their message (`withErrorMessages`,
`interceptor.go:36-44`, asserted in `runner_test.go:31-37`).

| Procedure | Handler | Request → response (fields the handler touches) |
|---|---|---|
| `Register` | `runner/runner.go:44-114` | `RegisterRequest{token, name, agent_labels[], version, ephemeral, capabilities[]}` → `RegisterResponse{runner{id, uuid, token, name, version, labels, ephemeral}}`. Validates token+name non-empty (`:48`); looks up `ActionRunnerToken` by the raw token string (`:52`), requires `is_active` (`:57` — reset semantics below); creates `ActionRunner{uuid: uuid.New(), name(≤255), owner/repo from the token, version, labels, ephemeral, has_cancelling_support iff capabilities contains "cancelling"}` (`:73-87`); `GenerateAndFillToken` mints the runner's polling token (`:88`). NOTE (draft correction): the post-success `runnerToken.IsActive = true` write (`:96-98`, unchanged since 4011821c94 "Implement actions") is a vestigial no-op — at this pin a registration token is **reusable until reset**: `NewRunnerTokenWithValue` deactivates all same-scope tokens in one transaction before inserting the new active one (`models/actions/runner_token.go:75-107`), so "reset" = create-new-and-deactivate-old, and one active token registers a fleet. The 2026-10-24 draft's "single-use, flipped inactive" claim was wrong. |
| `Declare` | `runner.go:142-165` | `DeclareRequest{version, labels, capabilities}` → `DeclareResponse{runner{id, uuid, token, name, version, labels}}`. Updates `agent_labels`, `version`, `has_cancelling_support` (`:128-140`); advertises server capabilities via the `X-Gitea-Actions-Capabilities` response header — `actions_model.RunnerCapabilities()` returns `"job-summary"` today (`models/actions/run_job_summary.go:30-34`) — "to avoid a hard dependency on a proto bump" (`:151-154`). |
| `FetchTask` | `runner.go:168-217` | `FetchTaskRequest{tasks_version}` → `FetchTaskResponse{task?, tasks_version}`. **Answer-immediately, not a held long poll**: the runner polls; the server compares the runner's `tasks_version` against `GetTasksVersionByScope(owner, repo)` (`:176`), bootstrapping the counter to 1 on first sight so the runner never sees version 0 ("would treat it as an old version of Gitea", `:179-187`). On mismatch it re-loads the runner fresh (a disable-while-polling race, `:190-195`) and calls `TryPickTask` — which is **throttled per-process** (`MAX_CONCURRENT_TASK_PICKS`, default 16, `modules/setting/actions.go:18,45,55`; `services/actions/task.go:31-53`): a throttled pick keeps the response's `tasks_version` at the runner's stale value so it retries on its next poll instead of sleeping to the next bump (`:202-207`). Version bumps cascade global→owner→repo counters (`IncreaseTaskVersion`, `models/actions/tasks_version.go:66-86`). |
| `UpdateTask` | `runner.go:220-285` | `UpdateTaskRequest{state{id, result: Result enum}, outputs: map<string,string>}` → `UpdateTaskResponse{state{id, result}, sent_outputs[]}`. State machine via `UpdateTaskByState` (`models/actions/task.go:481`); outputs are upsert-if-absent with caps — key ≤255 B, value ≤1 MiB, oversized keys/values logged-and-skipped (`:231-249`); responds with the keys actually stored so the runner can resend the rest (`:250-254`). Then: commit statuses for the job (`:263`), `NotifyWorkflowJobStatusUpdateWithTask` when done (`:265-267`), and when the result is non-UNSPECIFIED the job emitter re-resolves the run's needs graph (`EmitJobsIfReadyByRun`, `:270-276`) + run-level status notification (`:273-275`). |
| `UpdateLog` | `runner.go:288-359` | `UpdateLogRequest{task_id, index (row index of rows[0]), rows[]{time, content}, no_more}` → `UpdateLogResponse{ack_index}`. Ownership check (`runner.ID == task.RunnerID`, `:299-301`); the ack protocol: rows the server already holds are trimmed `rows[ack-index:]` (`:304-308`); a re-sent finalize with no new rows is acked idempotently (`:311-317`); appending rows past the seal errors `AlreadyExists` (`:312-313`); a `no_more` finalize with a gap (runner outran the server) is refused so the log never archives with holes (`:322-325`); `WriteLogs` appends bytes to the DBFS file — even with zero rows at offset 0, to bootstrap an empty file (`:327-330`); `task.LogLength` (row count), `task.LogSize` (byte size), `task.LogIndexes` (per-row byte offsets) advance (`:334-338`); `no_more` seals: `log_in_storage = true` + `TransferLogs` to object storage (`:343-348`). The mount keeps unlimited read size ("runners send all pending log rows in one UpdateLog", `:34-35`, `WithReadMaxBytes(0)`). |

**PingService** (`ping/ping.go:31-42`): `Ping(PingRequest{data})` →
`PingResponse{data}` — an echo used by runners as a connectivity probe.

**Wire format**: connect handlers accept connect/gRPC/gRPC-Web
(`connecthttp.Mount`, `runner.go:35`; compression floor `WithCompressMinBytes(1024)`).
The exact protocol variant + codec a stock act_runner speaks is settled by the
same wire-freeze fetch (the generated client code is in the module), and the
E2E real-runner test (§6.5) is the empirical confirmation.

### 2.3 The claim-time Task payload

`PickTask` (`services/actions/task.go:66-131`) → `CreateTaskForRunner`
(`models/actions/task.go:265-331`: keyset-paginated scan of waiting jobs,
`pickTaskBatchSize = 100`, ordered oldest-first; label intersection via
`CanMatchLabel`/`CanMatchLabels`, `models/actions/runner.go:202-204`; ephemeral
runners are refused new tasks while their task lives and deleted after it
finishes, `services/actions/task.go:77-95`) → `claimJobForRunner` (`:333-414`): the claim is a
conditional UPDATE — `task_id = 0 AND status = waiting` guard, one row affected
or `errJobAlreadyClaimed` (`:392-400`) — and task creation also inserts the
workflow's step rows (`:373-389`) and sets `LogFilename` from
`logFileName(repoFullName, taskID)` (`:369`). A failed payload assembly releases
the claim (`ReleaseTaskForRunner`, `:420`), as does a cancelled request context
(`services/actions/task.go:123-128`).

`buildRunnerTask` (`services/actions/task.go:135-174`) returns the
`runnerv1.Task{id, workflow_payload, context, secrets, vars, needs}`:

- `workflow_payload` — the job's stored single-job `SingleWorkflow` bytes re-
  serialized with the job's `if:` forced to `always()` (`runnerWorkflowPayload`,
  `:176-187`): the server already decided; the runner must not re-evaluate.
- `context` — the `gitea`/`github` context struct (`generateTaskContext`,
  `:189-215`; `GenerateGiteaContext`, `services/actions/context.go`) plus
  `token` (the task's polling token) and `gitea_runtime_token` (the HS256 JWT of
  §4.4), plus `actions_id_token_request_url`/`..._token` when OIDC is permitted
  (`:203-212`).
- `secrets` — `GetSecretsOfTask` (repo/org/user scope merge, `models/secret` —
  our `secrets` table already exists, §4.1).
- `vars` — `GetVariablesOfRun` (our `action_variables` table, §4.1).
- `needs` — `findTaskNeeds` (`:217-230`): map of job-id →
  `TaskNeed{outputs, result}` read from the needs' tasks' outputs.

### 2.4 Artifacts v1 (`/api/actions_pipeline/_apis/pipelines/workflows/{run_id}/artifacts`)

Auth: `Authorization: Bearer <ACTIONS_RUNTIME_TOKEN>` — the per-task HS256 JWT
(§4.4; `artifacts.go:146-155`); legacy runners send the raw task token
(`artifacts.go:170-180`). Run-id must match the token's job
(`artifacts_utils.go:35-44`).

Protocol (documented verbatim in `artifacts.go:6-61`):

1. `POST .../artifacts` → upload URL keyed by `md5(name)`; `?retentionDays=`
   rides the returned URL (`artifacts.go:119, 232-238`).
2. `PUT .../{artifact_hash}/upload` — chunked; headers `x-tfs-filelength`,
   `x-actions-results-md5`, `content-range: bytes s-e/total`
   (`artifacts.go:121`; consts `artifacts_utils.go:18-21`; streamed-md5 chunk
   save `artifacts_chunks.go:75-125`; chunk objects named
   `{run}-{artifact}-{start}-{end}.chunk`, `artifacts_chunks.go:44-51`).
3. `PATCH .../upload` — confirm; the server merges chunks in byte order into one
   stored object (ordered MultiReader → single `Save`, optional sha256
   verification, `artifacts_chunks.go:260-296, 311-399`; storage path analog
   `:298-307`).
4. `GET .../artifacts` (list), `GET .../{artifact_hash}/download_url`,
   `GET .../{artifact_id}/download` (`artifacts.go:119-124`).

### 2.5 Artifacts v4 (twirp-style, the modern toolkit path)

Routes (`artifactsv4.go:140-161`): `POST CreateArtifact | FinalizeArtifact |
ListArtifacts | GetSignedArtifactURL | DeleteArtifact`, `PUT UploadArtifact` and
`GET DownloadArtifact` on HMAC-signed URLs. **The proto is IN-TREE** —
`routers/api/actions/artifact.proto` defines all five request/response pairs
(`CreateArtifactRequest{workflow_run_backend_id, workflow_job_run_backend_id,
name, expires_at, version, mime_type}` → `{ok, signed_upload_url}`;
`FinalizeArtifactRequest{..., size, hash}` → `{ok, artifact_id}`;
`ListArtifacts...`; `GetSignedArtifactURL...` → `{signed_url}`;
`DeleteArtifact...`) — so the v4 codec needs no external material. Bodies are
protojson, capped at 1 MiB (`parseProtobufBody` `:298-316`,
`maxProtobufBodySize` `:296`) — only the upload/download URLs carry bulk bytes.
Signed URLs: HMAC-SHA256 over (tag, endpoint, expires, artifactName, taskID,
artifactID) with the general token-signing secret (`modules/actions/artifacts.go:19-29`;
build at `artifactsv4.go:162-175`), 60-minute expiry (`:168`), verified at
`:217-261`. Upload semantics: `?comp=block|appendBlock|blocklist` — Azure-Blob-
flavored block upload with an XML blocklist naming the final block order
(`:404-460`; ordered replay `artifacts_chunks.go:186-258`; tmp object
`tmp-upload/run-{id}-v4`, `artifacts_chunks.go:35-37`).

### 2.6 Job summaries (`GITHUB_STEP_SUMMARY`)

`PUT /api/actions_pipeline/_apis/pipelines/workflows/{run_id}/jobs/{job_id}/steps/{step_index}/summary`
(route base `job_summary.go:19`, table `artifacts.go:128`). Validates job + step
index against the task (`job_summary.go:27-47`), markdown-only content type
(`:91-104`), empty body clears (`:62-69`), per-step cap 1 MiB and aggregate
per-job cap 1 MiB ("matches GitHub's documented cap", `models/actions/run_job_summary.go:23-29`).

### 2.7 The Actions OIDC issuer

Three GETs under `/api/actions/oidc` (`actions.go:16-20`,
`routers/api/actions/oidc.go`):

- `/.well-known/openid-configuration` — issuer = `<AppURL>api/actions/oidc`
  (`services/actions/oidc.go:102-104`); discovery doc `oidc.go:17-28`.
- `/jwks` — RS256 public JWK (`oidc.go:31-49`; key lazily created/persisted as
  PEM at `<AppDataPath>/jwt/actions_oidc.pem`, `services/actions/oidc.go:41-54`).
- `/token` — **token exchange, not OAuth2**: bearer = a short-scoped
  `Actions.IDTokenRequest` JWT minted for the task when the workflow declares
  `id-token: write` (`services/actions/auth.go:20`; minted in
  `services/actions/task.go:203-212`), + `?audience=`; verifies the task is
  running and permitted (`services/actions/oidc.go:115-139`), returns
  `{value: <id_token>}` with `Cache-Control: no-store` (`oidc.go:52-60`).

ID-token claims mirror GitHub's (`services/actions/oidc.go:56-82`): immutable-ID
subject (`:172-178`), 5-minute expiry with 5-minute not-before backdating
(`:193-194`), `runner_environment: "self-hosted"` (`:221`).

### 2.8 The `/api/v1` registry family Actions adds

Shared registration via `addActionsRoutes` (`routers/api/v1/api.go:964-996`),
wired at repo level (`:1255` — `reqRepoReader(unit.TypeActions)` reads /
`reqOwner()` writes; **unit.TypeActions = unit 10**, `models/unit/unit.go:35`),
org level, and user level (`:1112-1133`):

- secrets: `GET /actions/secrets`, `PUT|DELETE /actions/secrets/{secretname}`
  (`api.go:968-972`) — our `secrets` table + service exist (§4.1).
- variables: `GET`, `GET|DELETE|POST|PUT /actions/variables/{variablename}`
  (`:974-982`) — our `action_variables` table + service exist.
- runners: `GET /actions/runners`, `POST /actions/runners/registration-token`,
  `GET|DELETE|PATCH /actions/runners/{runner_id}` (`:984-990`) — the
  registration-token mint the runner protocol consumes (§2.2).
- runs/jobs listing: `GET /actions/runs`, `GET /actions/jobs` (`:992-993`).
- Repo-level extras: workflows `GET .../actions/workflows[...]/runs`,
  `PUT .../disable|enable`, `POST .../{workflow_id}/dispatches` (`:1255-1263`)
  and `GET /actions/jobs/{job_id}/logs` (`:1264-1267`).

Scope enforcement rides the surrounding groups' `tokenRequiresScopes` — the
`/repos` group carries the `repository` category (`api.go:1554`), org/user
groups carry `organization`/`user` — all three categories already exist in our
frozen 19-bit grammar with headroom (`apps/worker/src/auth/scopes.ts:16-26`).
No new scope category is needed.

### 2.9 The trigger chain (the M3 slice)

The Actions notifier implements the `notify_service.Notifier` interface — 35
hook methods (`services/actions/notifier.go:41-784`): issues/labels/milestones/
comments (`:41-306`), PRs + reviews (`:355-540`), push/create/delete
(`:541-644`), releases (`:645-663`), packages (`:664-673`), wikis
(`:737-783`), migrations/automerge (`:674-736`). Each hook builds a webhook
payload and calls `notify` (`notifier_helper.go:136`), which: breaks the
Actions-user cycle ("a comment … will trigger the runner to add a new comment …
and trigger the runner again", `:139-155`), skips empty/archived/unit-disabled
repos (`:156-172`), falls back to the default branch for default-branch-only
events (`:178-189`), applies `[skip ci]`-family suppression
(`skipWorkflows`; strings `modules/setting/actions.go:51`), then
`DetectWorkflows` (`modules/actions/workflows.go:180-240`): workflow files are
`.yml`/`.yaml` under `.gitea/workflows` + `.github/workflows`
(`WORKFLOW_DIRS`, `modules/setting/actions.go:52`), enumerated recursively
from the commit tree (`workflows.go:75-108`), read with a **1 MiB per-file cap**
(`GetContentFromEntry`, `workflows.go:110-121`), events extracted per file, then
matched per event — push matching incl. branch filters/paths-ignore
(`matchPushEvent` `workflows.go:390`), plus issue/PR/release/package/workflow_run
matchers (`workflows.go:499-898`). Path/branch-filtered workflows still post a
**skipped commit status** when the context is a required check
(`handleFilteredWorkflows`; `CreateSkippedCommitStatusForFilteredWorkflow`,
`services/actions/commit_status.go:218`).

`InsertRun` (`services/actions/run.go:63-…`): per-repo run index from the named
sequence `action_run_index` via `db.GetNextResourceIndex` (`:67` — our
`repo_counters` idiom, §4.5), run + attempt-1 rows, workflow-level concurrency
evaluation, then jobs parsed and inserted with their `WorkflowPayload` bytes.
The **job emitter** re-resolves needs/`if`/concurrency after insert and after
every task completion (`EmitJobsIfReadyByRun`/`ByJobs`,
`services/actions/job_emitter.go:41-64`; the resolver `jobStatusResolver`
`:451-548`; run-level concurrency `:183`; max-parallel slots
`services/actions/max_parallel.go`; deferred matrices expand when needs finish,
`modules/actions/jobparser/jobparser.go:16-31`; bounded by
`MaxJobNumPerRun = 256`, `models/actions/run_job.go:29`). Upstream drives the
emitter through its own internal queue `actions_ready_job`
(`services/actions/init.go:63-67`).

**Expression evaluation is server work**: the parser imports actionslib's
`expreval`/`exprparser`/`model` (`modules/actions/jobparser/jobparser.go:12-14`;
the interpreter wiring `interpeter.go:24-64`) — the workflow schema model AND
the GitHub-expression evaluator are external Go, not vendored. This is the
largest single port cost and the reason M3 is staged behind Open question 1;
the control plane never evaluates expressions (the claim payload forces
`if: always()`).

Commit statuses: context `"<workflow> / <job> (<event>)"`
(`WorkflowStatusContextName`, `modules/actions/workflows.go:159-165`), posted
for push/PR/release-family events (`ShouldEventCreateCommitStatus`, `:172-178`)
via `CreateCommitStatusForRunJobs` (`services/actions/commit_status.go:31`),
state mapping `toCommitStatus` (`:357`), required-check globs consulted for
pending-job replacement (`:184-217`).

### 2.10 The UI family (page census for the M1c wave)

- **Repo Actions tab** (`routers/web/web.go:1566-1609`): `GET /{owner}/{repo}/actions`
  (runs list `actions.List`), `/job_queue`, workflow enable/disable + run +
  dispatch-inputs + approve-all-checks, and the run viewer subtree
  `/runs/{run}[/attempts/{attempt}][/jobs/{job}]` (view + log streaming
  `GET /runs/{run}/jobs/{job}/logs`, rerun/cancel/approve/delete POSTs,
  artifact download/delete per name, workflow-file view). Templates:
  `templates/repo/actions/` — 10 files (`list.tmpl`, `runs_list.tmpl`,
  `view.tmpl`, `view_component.tmpl`, `sidebar.tmpl`, `no_workflows.tmpl`,
  `job_queue.tmpl`, `workflow_dispatch.tmpl`, `workflow_dispatch_inputs.tmpl`,
  `artifact_preview.tmpl`). Handlers: `routers/web/repo/actions/` — 9 files
  (`actions.go`, `view.go`, `view_artifact.go`, `badge.go`, `job_queue.go`).
  The log viewer is live-tail shaped (the `view.go` + `Logs` handler polling
  `ReadLogs` ranges).
- **Owner settings** (org/user, `web.go:489-522`): variables CRUD,
  runners list/edit/delete/reset-registration-token, scoped-workflows admin.
- **Repo settings** (`web.go:491-513` shared builders): the same runners +
  variables + secrets pages.
- **Admin** (`web.go:898-904`): runners bulk actions + the global job queue page.
- **Shared templates**: `templates/shared/actions/` — 11 files (`runner_list`,
  `runner_edit`, two runner_badge variants, `job_queue_list`,
  `owner_general_settings`, `permission_mode_select`, `permissions_table(+unit)`,
  `scoped_workflows`, `workflow_run`); handlers `routers/web/shared/actions/` —
  6 files (`runners.go`, `variables.go`, `job_queue.go`, `general.go`,
  `scoped_workflows.go`).
- **Mail**: `templates/mail/repo/actions/`.
- **Artifact preview**: `GET /-/actions/artifacts/{id}/{expires}/{signature}/*`
  (`web.go:293` — no session; the sandboxed iframe sends no cookies), gated by
  `ARTIFACT_PREVIEW_MAX_SIZE` (default 10 MiB, `modules/setting/actions.go:47,56`).

## 3. The v1 surface staged

**M1 lands (the control plane; §7 sizes):** mounts §2.1; runner protocol §2.2;
claim payload §2.3; artifacts v1+v4 §2.4-2.5; summaries §2.6; OIDC §2.7; the
`/api/v1` registry family §2.8; the D1 schema §4.1 (control-plane tables);
R2 log/artifact keys §4.2-4.3; retention arms §4.4; the UI family §2.10.

**M3 lands (the trigger chain; gated on Open question 1):** the notifier hooks
census §2.9 wired to our `onPush`/event seams, workflow detection + matchers,
the YAML model port, the expression subset of OQ-1, `InsertRun` + the job
emitter + max-parallel, commit-status publication, `[skip ci]` suppression.
Without M3 the M1 control plane has no automatic producer — jobs arrive via the
test harness/fixtures (how upstream's own protocol suites run too) and, once M3
ships, from real events.

**Deferred beyond M3:** scheduled workflows (§1.4), scoped + reusable workflows,
rerun/multi-attempt, packages triggers, the checkout shim (§1.4), the managed
runner (§1.2).

## 4. Data model

### 4.1 D1 tables (one migration family via `pnpm db:generate`)

Column-for-column ports of `gitea/models/actions/*` onto D1 types (TEXT enum
convention per the schema's house style; booleans as integer 0/1). Twelve new
tables below (the schedule pair is deferred, §1.4); two already exist:

- **`action_runners`** (port of `ActionRunner`, `models/actions/runner.go:26-51`): `id` pk;
  `uuid` TEXT UNIQUE; `name` TEXT(255); `version` TEXT(64); `owner_id` idx
  (0 = global); `repo_id` idx; `description` TEXT; `base` int (0 native /
  1 docker / 2 VM); `repo_range` TEXT; `token_hash` TEXT UNIQUE (sha256 — the
  SPEC-0002 digest model); `token_salt` TEXT; `last_online` / `last_active` int
  idx; `agent_labels` TEXT (JSON array); `ephemeral`, `is_disabled`,
  `has_cancelling_support` int NOT NULL DEFAULT 0; `created`/`updated`/`deleted`
  int. The plaintext token is never stored (`Token xorm:"-"`).
- **`action_runner_tokens`** (port of `ActionRunnerToken`,
  `models/actions/runner_token.go:26-37`): `id` pk; `token` TEXT UNIQUE — the
  registration token is stored RAW upstream (`GetRunnerToken` looks it up by
  the presented string, `:50-58`) and stays raw for parity (unlike the
  post-registration runner token, which is salted-hash); `owner_id` idx;
  `repo_id` idx; `is_active` int (the reset lifecycle, §2.2);
  `created`/`updated`/`deleted`.
- **`action_runs`** (port of `ActionRun`, `models/actions/run.go:32-76`): `id` pk; `repo_id` UNIQUE(repo_index) +
  idx(repo_status); `owner_id` idx; `workflow_id` idx; `index` int
  UNIQUE(repo_index) — the per-repo run number (`action_run_index` sequence,
  §2.9 → our `repo_counters` + a new `runIndex` column, §4.5); `trigger_user_id`
  idx; `schedule_id` int DEFAULT 0; `ref` idx; `commit_sha` idx;
  `is_fork_pull_request`, `need_approval` int; `approved_by` idx;
  `event` TEXT; `event_payload` TEXT (JSON); `trigger_event` TEXT; `status` int
  idx (the 10-value Status enum, `models/actions/status.go:15-25`);
  `version` int (optimistic lock); `raw_concurrency` TEXT; `workflow_repo_id`,
  `workflow_commit_sha`, `is_scoped_run` (parity columns, unread in v1);
  `started`/`stopped` int; `previous_duration` int DEFAULT 0 (legacy-only);
  `latest_attempt_id` idx DEFAULT 0; `created`/`updated`.
- **`action_run_jobs`** (`run_job.go:24-130+`): `id` pk; `run_id` idx; `repo_id`
  idx(repo_concurrency) idx(repo_status); `owner_id` idx; `commit_sha` idx;
  `is_fork_pull_request`; `name` TEXT(255); `attempt` int; `workflow_payload`
  BLOB (the single-job YAML); `job_id` TEXT(255) (the YAML job key);
  `needs`/`runs_on` TEXT (JSON arrays); `task_id` idx(pickup) DEFAULT 0;
  `source_task_id` DEFAULT 0; `status` int idx; `raw_concurrency` TEXT;
  `is_concurrency_evaluated` int; `concurrency_group` TEXT idx(repo_concurrency)
  DEFAULT ''; `concurrency_cancel` int DEFAULT 0; `token_permissions` TEXT
  (JSON); `max_parallel` int DEFAULT 0; `is_matrix_deferred` int DEFAULT 0;
  `deferred_matrix_payload` BLOB; `run_attempt_id` idx DEFAULT 0;
  `attempt_job_id` idx DEFAULT 0; the reusable-workflow columns
  (`workflow_source_repo_id`, `workflow_source_commit_sha`, `is_reusable_caller`,
  `is_expanded`, `call_uses`, `reusable_workflow_content`, `reusable_workflow_ref`,
  `call_secrets`, `call_payload`, `parent_job_id` idx, `continue_on_error`) —
  all parity-ported, unread in v1.
- **`action_run_attempts`** (`run_attempt.go`): `id` pk; `repo_id`
  idx(repo_concurrency_status); `run_id` + `attempt` UNIQUE(run_attempt);
  `trigger_user_id`; concurrency columns; `status` idx; `started`/`stopped`;
  `created`/`updated`. v1 always attempt = 1.
- **`action_tasks`** (port of `ActionTask`, `models/actions/task.go:40-66`): `id` pk; `job_id`; `attempt`; `runner_id`
  idx; `status` idx; `started` idx; `stopped` idx(stopped_log_expired); `repo_id`
  idx; `owner_id` idx; `commit_sha` idx; `is_fork_pull_request`; `token_hash`
  UNIQUE; `token_salt`; `token_last_eight` idx; `log_filename` TEXT;
  `log_in_storage` int; `log_length` int (rows); `log_size` int (bytes);
  `log_indexes` BLOB (row→offset map); `log_expired` idx(stopped_log_expired);
  `created`/`updated` idx.
- **`action_task_steps`** (`task_step.go`): `id` pk; `name` TEXT(255);
  `task_id` + `index` UNIQUE(task_index); `repo_id` idx; `status` idx;
  `log_index`/`log_length` int; `stage` int DEFAULT 0; `number` int DEFAULT 0;
  `started`/`stopped`/`created`/`updated`.
- **`action_task_outputs`** (`task_output.go`): `id` pk; `task_id` +
  `output_key` UNIQUE(task_id_output_key); `output_value` TEXT.
- **`action_tasks_versions`** (`tasks_version.go:16-24`): `id` pk; `owner_id`
  UNIQUE(owner_repo); `repo_id` UNIQUE(owner_repo); `version` int;
  `created`/`updated`. Scopes: (0,0) global, (owner,0) owner, (0,repo) repo —
  bumps cascade all three (§2.2).
- **`action_artifacts`** (port of `ActionArtifact`, `artifact.go:62-90`): `id` pk; `run_id`
  UNIQUE(runid_attempt_name_path) idx; `run_attempt_id` (uq part) DEFAULT 0;
  `runner_id`; `repo_id` idx; `owner_id`; `commit_sha`; `storage_path` TEXT;
  `file_size`/`file_compressed_size` int; `content_encoding_or_type` TEXT
  DEFAULT ''; `artifact_path` + `artifact_name` (uq parts) TEXT; `status` int
  idx (UploadPending=1 → UploadConfirmed=2 → Expired=4 → PendingDeletion=5 →
  Deleted=6; UploadError=3 reserved, `artifact.go:25-30`); `created`/`updated`
  idx; `expired_unix` idx (0 = keep forever).
- **`action_run_job_summaries`** (port of `ActionRunJobSummary`,
  `models/actions/run_job_summary.go:36-49`): `id` pk; `repo_id`
  + `run_id` + `run_attempt_id` + `job_id` + `step_index` UNIQUE(summary_key);
  `content` TEXT; `content_type` TEXT DEFAULT 'text/markdown'; `content_size`
  int DEFAULT 0; `created`/`updated`.
- **`action_log_chunks`** (our DBFS analog, §4.3 — no upstream table of its
  own; upstream scopes its log chunks inside the generic `dbfs` table):
  `id` pk; `task_id` idx; `seq` int (append order); `bytes` BLOB.
  UNIQUE(`task_id`, `seq`) guards the append order; rows are deleted when the
  log seals to R2.
- **`action_schedule_specs`** / **`action_schedules`** — deferred to the
  scheduled-workflows milestone (§1.4); NOT in the M1a migration (no reader).
- **Already exist** (verified `apps/worker/src/db/schema.ts`): `secrets`
  (`schema.ts:2292` — upstream-parity columns incl. the owner/repo scope
  encoding and the documented plaintext divergence) and `action_variables`
  (`schema.ts:2334`). `commit_statuses` (`schema.ts:906`) serves §2.9's
  publication arm. No new table for them — M1a only adds the read-side service
  arms (`GetSecretsOfTask`/`GetVariablesOfRun` equivalents).

### 4.2 R2 keys

Under the shared `REPO_PACKS` bucket (the only binding,
`wrangler.jsonc.example:94-101`), one new namespace, keys as pure functions of
validated segments (the LFS injection-proof rule, `services/lfs/store.ts:5-9`;
D1 stores bare rows only):

```
actions/logs/<log_filename>                       # sealed task logs (§4.3; log_filename is logFileName(repoFullName, taskID))
actions/tmp/<run_id>/v3/<run>-<artifact>-<s>-<e>.chunk    # v1 chunks (artifacts_chunks.go:44-51 shape)
actions/tmp/<run_id>/v4/tmp-upload/run-<run_id>-v4        # v4 spool object (artifacts_chunks.go:35-37)
actions/artifacts/<run_id>/<artifact_id>          # merged artifact (storage_path; artifacts_chunks.go:298-307 analog)
```

- Chunk/block ingest is a streaming R2 PUT per request — never buffered
  (AGENTS.md stream-don't-buffer rule; the isolate memory cap makes buffering a
  10 GiB artifact impossible; every path streams).
- **The merge**: upstream re-reads chunks in order through an in-process
  MultiReader (`artifacts_chunks.go:333-349`). R2 has no server-side
  concatenation (the same gap SPEC-0001a recorded — workerd#1349). Proposal
  (unchanged from the draft, §5.5 for failure windows): stream-merge inside ONE
  request — open chunk objects sequentially and pipe into a single R2 multipart
  upload part by part (near-zero CPU; wall time is R2 throughput, free under the
  unbounded-HTTP-wall rule). Very large finalizes can move to the `repo-tasks`
  consumer if instrumentation says so (§8 note).
- Downloads: v4's HMAC-signed URLs map onto our own HMAC scheme — same
  construction as upstream (`modules/actions/artifacts.go:19-29`); the
  presign/relay duality precedent is SPEC-0006's LFS store
  (`services/lfs/batch.ts:16-24`).

### 4.3 Log storage: the DBFS mapping is direct

Upstream's hot log store is **DBFS — a database-backed virtual file** (chunk
rows in the `dbfs` table; `WriteLogs` opens `actions_log/<log_filename>` with
O_APPEND semantics, refuses writes past a shrunk file to avoid content holes,
seeks to the offset, and appends the row-formatted bytes,
`modules/actions/log.go:35-78`). Row format: `"<RFC3339 7-digit-fraction UTC> <content>\n"`,
newlines inside content escaped as literal `\n`, lines truncated at 64 KiB
(`MaxLineSize`, `FormatLog`, `log.go:24-30, 213-220`). Sealing: `TransferLogs`
copies the file into object storage — compressed ONLY when the filename ends
`.zst` (the `LOG_COMPRESSION` setting; upstream's own default is zstd but
`none` is a valid setting, `modules/setting/actions.go:30,137-138`) — then
deletes the DBFS file.

Workers mapping (parity, not deviation): **`action_log_chunks`** — D1 rows
`(task_id, seq, bytes)` mirroring DBFS chunk rows scoped to one log file; the
`UpdateLog` handler appends one chunk row per call (the protocol already batches
rows per call), maintaining `log_length`/`log_size`/`log_indexes` on the task
row exactly as upstream. On `no_more`, a same-request stream-merge (D1 chunk
rows → one R2 object `actions/logs/<log_filename>`) flips `log_in_storage`;
the DBFS row family is deleted after the object is durable (upstream's `remove()`,
`routers/api/actions/runner/runner.go:354-356`). Divergence (documented): sealed logs are stored
**uncompressed** — upstream's `LOG_COMPRESSION = none` shape — because zstd is
not a Workers platform primitive; gzip would be a gratuitous deviation from the
byte format, and uncompressed log objects stream fine. Reads (UI log panel,
`GET /actions/jobs/{id}/logs`) hit D1 hot chunks or the R2 sealed object via
`ReadLogs`-equivalent parsing (same line format, same 64 KiB cap).

### 4.4 Auth, keys, retention

- **Runtime JWT** (artifacts/auth; §2.4): HS256 over claims
  `{scp: "Actions.Results:{run}:{job}", ac: <cache-scope JSON>, task_id, run_id,
  job_id}` with 1 h + EndlessTaskTimeout expiry (`services/actions/auth.go:22-70`;
  timeout defaults `modules/setting/actions.go:133-135`, endless = 3 h) signed with the
  general token-signing secret → one Worker secret (`wrangler secret`), replacing
  `GetGeneralTokenSigningSecret`. The OIDC request JWT reuses the same signer
  with `scp = "Actions.IDTokenRequest"` (`auth.go:20, 92-112`).
- **OIDC signing key**: upstream persists an RS256 PEM on disk
  (`services/actions/oidc.go:41-54`). Workers: generate once (Web Crypto RS256
  is native), store the private PKCS-8 in D1 (the AES-encrypted secret pattern,
  SPEC-0009's mirror-credential precedent), publish the JWK at `/jwks`.
- **Runner tokens**: salted sha256 (`auth_model.HashToken`), the SPEC-0002
  digest model verbatim (`interceptor.go:97-107`).
- **Retention** (`modules/setting/actions.go:19-21,57-59`): artifacts 90 d,
  logs 365 d, runs 400 d — the cleanup arm (§4.5) ports
  `cleanup/Task` equivalents as `ACTIONS_ARTIFACT_RETENTION_DAYS` /
  `ACTIONS_LOG_RETENTION_DAYS` / `ACTIONS_RUN_RETENTION_DAYS` strict-polarity
  vars with upstream defaults. Upstream has no artifact SIZE cap in code — that
  gap is Open question 3.

### 4.5 Queue, cron, and the no-DO posture

- **Poll/claim is request/response**: the runner polls US; FetchTask answers
  immediately from D1 (§2.2) — no DO, no websockets, no held sockets.
- **The claim race is a conditional UPDATE** (`task.go:392-400`) — the exact
  D1+Drizzle CAS pattern the repo already uses; D1 serializes it per-row.
- **The job emitter** (M3): upstream runs it inline in UpdateTask through its
  internal `actions_ready_job` queue (`services/actions/init.go:63-67`). Our
  mapping: bounded emitter work (needs-graph re-resolution over one run's jobs)
  runs inline in the UpdateTask request exactly as upstream's handler does,
  with a `repo-tasks` enqueue fallback (`{kind: "actions-emit", runId}` joining
  the serialized `handleRepoTasks` dispatch, `src/repos/purge.ts` family) if a
  run's emitter work grows beyond the inline budget. The message kind joins the
  authoritative dispatch-arms doc (`src/repos/dlq.ts:30`).
- **Retention/cleanup**: an hourly-producer block joins the scheduled dispatcher
  (the SPEC-0014 §3 sanctioned-extension pattern: SELECT due work → enqueue;
  the consumer executes — artifact expiry flips + R2 deletes, log sealing
  orphans, run/log row expiry, `StopTask` zombie sweep below). Beside it, the
  ALWAYS-ON sweeps family (`services/actions/sweeps.ts`) ports upstream's
  remaining always-on actions crons with no retention knob
  (`cron/tasks_actions.go`): `stop_endless_tasks` (RUNNING past
  `ENDLESS_TASK_TIMEOUT` 3h keyed on `started`), `cancel_abandoned_jobs`
  (waiting/blocked/pending quiet past `ABANDONED_JOB_TIMEOUT` 24h), and the
  ephemeral-runner pass of `Cleanup` (decoupled from the retention arming —
  upstream runs it unconditionally nightly). Same producer/consumer shape as
  the zombie pair: indexed LIMIT-1 probe → at most one `{kind:
  "actions-endless" | "actions-abandoned" | "actions-ephemeral-cleanup"}`
  message; a quiet instance sends zero.
- **Run numbering**: upstream's `action_run_index` named sequence
  (`services/actions/run.go:67`) maps onto `repo_counters` — a new `run_index`
  column beside `issue_index` (the `syncMaxIssueIndex` CAS idiom,
  `src/issues/service.ts:264-272`).
- **The pick limiter**: upstream's `MAX_CONCURRENT_TASK_PICKS` is a per-process
  semaphore (`services/actions/task.go:31-53`). On Workers each isolate carries
  its own semaphore — the throttle degrades to per-isolate (still safe: the CAS
  is the correctness mechanism; the limiter only damps herd load). Documented
  divergence, not a design change.

### 4.6 Divergence ledger (documented, each upstream-sanctioned or forced)

1. Sealed logs uncompressed (upstream's `LOG_COMPRESSION=none`; zstd unavailable
   on Workers) — §4.3.
2. OIDC private key in encrypted D1 instead of a PEM file — §4.4 (no disk).
3. Per-isolate pick limiter — §4.5.
4. Secrets stored plaintext (the existing `secrets` divergence, schema.ts:2288-2291;
   Actions reads them through the same service — no new posture).
5. DBFS chunk rows → `action_log_chunks` D1 table (same shape, different engine) — §4.3.
6. `repo_counters.run_index` instead of the `action_run_index` named sequence — §4.5.
7. RESOLVED (3bc5d29) — the crypto-material home. History: §4.4/entry 2
   spelled a `wrangler secret` (the HS256 signing secret) plus an
   AES-encrypted PKCS-8 row in D1 (the RS256 keypair); both homes required
   shared files outside the landing unit's exclusive ownership, so M1b
   (10cfb97) persisted BOTH in ONE private R2 object
   (`actions/_keystore/instance.json` — Worker-only readable, generated
   once, never rotated by code, the §4.2 namespace discipline) with
   `loadKeystore` (`services/actions/secrets.ts`) as the single swap point.
   As-built resolution: upstream stores NEITHER piece in a models table
   (the HS256 secret lives in the setting store, oauth2.go:129-150; the
   RS256 key is an AppData PEM, oidc.go:40-54) — the ratified no-app.ini
   substrate's D1 analog is the landed home: migration 0042's
   `system_keystore` table (write-once rows, one per piece; rotation is
   operator-only, exactly upstream's edit-app.ini-and-restart);
   generate-once-save-back with the race loser adopting the winner's
   material; the kid switched to upstream's exact
   base64url(SHA-256(SPKI DER)) spelling (util/keypair.go:48-56); and a
   one-time legacy adoption of M1b's R2 object on a cold D1 miss (the
   adopted pieces only — the object itself is never written or deleted by
   code).
8. RESOLVED (3bc5d29) — the retention-var wiring. History: M1b (10cfb97)
   shipped `retention.ts`'s §4.4 sweep arms PARAMETERIZED (the retention
   trio as arguments) with the env-var caller in flight. As-built
   resolution: the strict-polarity trio (ACTIONS_ARTIFACT_RETENTION_DAYS /
   ACTIONS_LOG_RETENTION_DAYS / ACTIONS_RUN_RETENTION_DAYS — any value
   other than a positive integer disarms that arm); the hourly producer
   block (gate before the first D1 read → one indexed LIMIT-1 probe per
   armed arm → at most ONE `{kind: "actions-retention"}` message CARRYING
   the parsed values, so the consumer runs exactly what was armed); the
   `{kind: "actions-zombie"}` pair riding the */10 step entry probe-gated
   (upstream's `stop_zombie_tasks` is an always-on @every 5m cron with NO
   retention knob, cron/tasks_actions.go:26-35 — hourly mounting would
   have degraded zombie latency to ~70 min); two typed consumer arms in
   `src/repos/purge.ts` before the purge fallback; and
   `wrangler.jsonc.example` documents the trio fail-closed (a default
   deployment NEVER deletes actions data — upstream's always-on defaults
   are opt-in here).
9. RESOLVED — the always-on sweeps family and the claim-window orphan. (a)
   The zombie stop picks its terminal status PER TASK
   (`clear_tasks.go:160-163`: CANCELLING → CANCELLED, RUNNING → FAILURE) —
   the first cut stopped both as FAILURE, flipping user-cancelled runs to
   failed through the aggregate. (b) `stop_endless_tasks` /
   `cancel_abandoned_jobs` port onto the always-on probe-gated
   producer/consumer shape (`services/actions/sweeps.ts`, ledger entry 8's
   zombie pair) — the M3-staged tails (`notifyAndEmitFinishedJobs`,
   the reusable-caller cascade) stay staged. (c) `CleanupEphemeralRunners`
   is hygiene, not retention: it moved OUT of the armed
   `runRetentionSweep` onto its own always-on arm — upstream runs it
   unconditionally inside every nightly `Cleanup`
   (`cleanup.go:34-47,144-165`). (d) Upstream claims a task inside ONE
   transaction (`claimJobForRunner`'s `db.WithTx`, `task.go:341-414`); the
   insert-then-CAS adaptation can strand an orphan RUNNING task whose job
   is still waiting (wedging an ephemeral runner on the one-task-per-
   lifetime check). D1 batches cannot roll back a sibling statement
   conditionally, so the compensating finalizer keys upstream's own
   terminalization on the job: a terminal `StopTask` finalizes every other
   live task row of the same job with the job's stop status, and the
   terminal arm carries the model-hook piggybacks upstream's StopTask path
   fires — the `UpdateRunJob` version wake (`run_job.go:511-530`), the
   `UpdateTask` ephemeral removal (`task.go:452-464`), and, for the sweep
   callers that pass the storage env, the `clear_tasks.go:177-187` log
   transfer (upstream's cancel path, `run_job.go:818-829`, transfers no
   logs — the env param mirrors that split).

## 5. Edge cases, limits, and failure modes

1. **Runner offline / heartbeat load** — online status is the debounced
   `last_online` (`ShouldPersistLastOnline`, `models/actions/runner.go:89-99`; `IsOnline`,
   `:145-156`); polls and log flushes must NOT write per-request (upstream's
   debounce exists because "writing on every poll is a major source of DB load",
   `interceptor.go:80-84`). Our interceptor-equivalent middleware carries the
   same debounce constants.
2. **tasks_version races** — bumps cascade global→owner→repo in one transaction
   (`models/actions/tasks_version.go:66-86`); a missing row self-heals by re-insert
   (`:49-59`); FetchTask bootstraps 0→1 so old runners don't misread
   (`routers/api/actions/runner/runner.go:179-187`); a throttled pick returns the
   runner's STALE version so it retries instead of sleeping (`:202-207`). The
   runner-served version is advisory only — the server always tries a pick on
   mismatch.
3. **Claim races** — the `task_id = 0 AND status = waiting` conditional UPDATE
   answers `errJobAlreadyClaimed` on loss (`models/actions/task.go:392-400`); the outer loop
   advances to the next candidate (`:303-331`). A crashed assembly releases via
   `ReleaseTaskForRunner` with a FRESH context (the request context is already
   cancelled — the exact upstream comment, `services/actions/task.go:55-64`).
   Ephemeral runners: one task per lifetime; the runner row is deleted after the
   task finishes and the next poll errors ("runner has been removed",
   `services/actions/task.go:77-95`).
4. **Log chunk ordering / sealing** — the ack-index protocol (§2.2): trim
   already-acked rows; refuse seals with gaps; ack re-sent finalizes
   idempotently; `AlreadyExists` for appends past the seal; the empty-log
   bootstrap write (offset 0, zero rows) so sealing an output-less task works
   (`routers/api/actions/runner/runner.go:311-330`). Our consumer mirrors each
   branch byte-for-byte —
   these are contract fixtures, not prose.
5. **Artifact expiry** — `expired_unix` 0 = forever; retention flips status
   Expired → PendingDeletion → Deleted with the R2 delete in the consumer arm
   (`artifact.go:21-44`); a re-upload of the same (run, attempt, name, path)
   is UNIQUE-blocked (`runid_attempt_name_path`) — the v1/v4 families answer
   with the existing row semantics, not a duplicate object.
6. **Zombie/endless/abandoned tasks** — upstream timeouts: zombie 10 min, endless
   3 h, abandoned job 24 h (`modules/setting/actions.go:133-135`); the hourly
   consumer arm sweeps (`StopTask`, `models/actions/task.go:568`). v1 ports the
   sweep; the var names ride §4.4's strict-polarity pattern.
7. **Caps** — proto/summary bodies 1 MiB (`artifactsv4.go:296`;
   `run_job_summary.go:23-29`); output keys 255 B / values 1 MiB, skipped not
   fatal (`routers/api/actions/runner/runner.go:231-249`); log lines 64 KiB (`log.go:25`); workflow files
   1 MiB (`workflows.go:115`); matrix ≤256 jobs (`run_job.go:29`).
8. **Cycle break** — events triggered BY the Actions user never re-trigger
   (the `ActionsUserID` guard, `notifier_helper.go:139-155`); M3 ports it (our
   trigger chain must recognize the system doer).
9. **Default-branch fallback** — events that only fire on the default branch
   read workflows from the default branch even when the push ref differs
   (`notifier_helper.go:178-189`).
10. **Proto-body parsing** — v4 accepts protojson only within the 1 MiB cap;
    oversized bodies fail before any R2 call (checked before and during
    streaming, the release-asset discipline).

## 6. Testing plan

### 6.1 Wire freeze (M1a step 0)

Fetch `gitea.dev/actionslib v1.5.0` from the public Go module proxy; verify the
hash against the in-tree go.sum line (`gitea/go.sum:15-16`,
`h1:dC3v2HTWbbvyNBSdg2W3kd4WNC/p+FnZaKpl1MdzM00=`); transcribe the `ping/v1`
and `runner/v1` `.proto` files into the repo as contract fixtures with the hash
recorded beside them. This replaces the draft's "capture a live session" M0 with
a cheaper, MORE precise freeze — the proto is pinned upstream truth, not
observed behavior. The header-name constants (`UUIDHeader`/`TokenHeader`) come
from the same fetch.

### 6.2 The fake-runner harness (the oracle)

A Node act_runner-protocol client (`tests/actions/fake-runner.ts` or
equivalent) implementing the FULL runner lifecycle over HTTP against the real
routes in workerd: ping → register (with a minted registration token) → declare
→ FetchTask poll loop (with a tasks_version cache) → receive the claim payload →
emit canned UpdateLog batches (rows, re-sends, past-seal appends, gap seals) →
UpdateTask result + outputs → v4 artifact create/upload-blocks/finalize/list/
download → v1-family round-trip → OIDC mint-and-verify → job-summary upload.
Every §5 branch that has a wire answer (trim/ack/AlreadyExists/gap-refusal,
throttled-pick version echo, output resend keys) is asserted from the runner's
seat. This harness is the standing oracle: it IS an act_runner for CI purposes,
and the real binary (§6.5) is the acceptance bar on top of it.

### 6.3 Unit + model tests (vitest, real bindings)

- Claim CAS under concurrent FetchTasks (two harnesses racing one waiting job —
  exactly one wins, the other gets `tasks_version` echo semantics);
  ephemeral-runner lifecycle; ephemeral refusal while its task lives.
- tasks_version cascade (global/owner/repo rows) + self-heal re-insert.
- UpdateTaskByState transitions incl. the optimistic-lock `version` column;
  output upsert-if-absent + resend-key list.
- Log math: `log_length`/`log_size`/`log_indexes` under trim/re-send; seal
  refuses gaps; empty-log bootstrap; hot→R2 seal flips `log_in_storage` and
  deletes chunks; ReadLogs round-trip parses the upstream line format.
- Artifacts: chunk name parse (v3), blocklist XML replay (v4), streamed-md5
  verification failure rejects, merge produces the merged object + row flip,
  HMAC signature verify/reject (expired, tampered name/taskID).
- OIDC: discovery doc shape, JWKS, exchange happy-path + wrong-scope/wrong-task
  rejections.
- Retention arms: expiry flips, R2 deletes, strict-polarity var disarm.

### 6.4 Trigger-chain tests (M3)

Workflow matchers differential-tested against recorded upstream input/output
pairs (push/PR/release filter semantics — the SPEC-0001b differential precedent);
the expression evaluator against the GitHub expression conformance cases
actionslib's own tests encode (extracted at wire-freeze); `[skip ci]` strings;
cycle break; default-branch fallback; commit-status context naming.

### 6.5 E2E acceptance bar

A real act_runner binary against local workerd running a trivial workflow
(echo → upload artifact → download → assert), log ack/resume, and OIDC
mint-and-verify. Unmodified runner, green suite — the §1.2 acceptance sentence,
empirically. Runs as a manual/release gate initially (CI container posture is
Open question 4).

### 6.6 Gates

`pnpm typecheck`; `pnpm test:full` per ADR-0006 — a single-file `pnpm test` pass
is never cited as suite-green; the `Tests ` line is read with our own eyes.

## 7. Milestones

Sizes are wave units (one wave ≈ one background-agent landing unit with review,
AGENTS.md pool discipline). M1 is staged for dispatch NOW; M2 follows M1; M3 is
gated on Open question 1's resolution.

| # | Milestone | Content | Size | Notes |
|---|---|---|---|---|
| M1a | Model + registration + dispatch | Migration (12 tables §4.1); the connect-RPC codec (per OQ-2); wire freeze §6.1; ping + Register/Declare; runner-token lifecycle (§2.2 NOTE); the `/api/v1` registration-token + runners-CRUD ops; FetchTask + tasks_version + the claim CAS + `TryPickTask`; `buildRunnerTask` payload (contexts, secrets/vars reads, needs); the interceptor middleware (uuid/token auth + debounced heartbeats); the fake-runner harness skeleton through claim | **L** | The codec is the unknown (OQ-2); everything else is ported shapes |
| M1b | UpdateTask + log + artifact ingestion | UpdateTask state machine + outputs + resend keys; UpdateLog ack/seal protocol + `action_log_chunks` + R2 seal + the logs-download endpoint; artifacts v4 (proto in-tree) then v1; job summaries; the OIDC issuer; retention/zombie consumer arm; harness grows to the full lifecycle (§6.2) | **L** | The streaming merge is the platform-hard part (§4.2) |
| M1c | The UI family | The repo Actions tab (runs list, run viewer + log panel, dispatch inputs, artifact preview/download, badge), owner/repo settings pages (runners, variables), admin runners + job queue — the §2.10 census, upstream-template-shaped under our UI conventions (SPEC-0008/0010 posture) | **L** | The largest single UI family after the core web UI; runs_list + view are the deep pages |
| M2 | Self-host runner docs | README/docs: enable Actions, mint a registration token, register act_runner, labels ↔ runs-on guidance, artifact/log retention defaults; the divergence ledger (§4.6) restated for operators | **S** | Rides M1a's registration flow; publishable after M1b (a runner is only useful once it can report) |
| M3 | The trigger chain | NOT the brief's "managed runner" (that stays out, §1.2): notifier census §2.9 wired to the `onPush`/create/delete seams via `repo-tasks` messages; workflow detection + YAML model port; the OQ-1 expression subset; InsertRun + run numbering; the job emitter + max-parallel + concurrency; commit statuses (+ skipped-status arm); `[skip ci]`; cycle break; harness + differential tests §6.4 | **L** | Gated on OQ-1; the port-fidelity risk lives here |

**Deferred (each its own future SPEC-attachment):** scheduled workflows (tables
+ cron producer riding the existing `*/10` entry — upstream's own cadence),
scoped + reusable workflows, rerun/multi-attempt, packages triggers, the v1
artifacts-family trimming if wire-freeze shows no legacy runners in practice.

## 8. Open questions

1. **The expression evaluator's Workers port (gates M3).** Upstream evaluates
   job-level `if:`, concurrency, and matrix expressions with actionslib's Go
   `expreval`/`exprparser` (§2.9) — no JS equivalent exists. Candidates:
   (a) hand-port the evaluator subset the server actually needs, rejecting
   unsupported expressions at insert with a visible error (the SPEC-0005
   visible-error discipline); (b) a full library port; (c) WASM-compile the Go
   evaluator. Decide at M3 dispatch; (a) is the working proposal.
   **RESOLVED 2026-10-31 — text preserved as written; the decision record and
   the M3 staging consequence are appended at the tail of this document
   ("Decision record — Open question 1 resolved").**
2. **Codec implementation strategy (M1a).** Hand-rolled protobuf
   encode/decode for the ~15 frozen message shapes vs a JS protobuf library
   (@bufbuild/protobuf or protobufjs) as a new dependency. Upstream uses
   generated Go — no JS answer to copy. Working proposal: hand-rolled minimal
   wire codec over the transcribed protos (no new deps, the frozen shape set is
   small and the contract fixtures pin it), revisited if varint/bytes edge
   cases pile up.
3. **Per-run artifact/log quota defaults.** Upstream caps NOTHING by size —
   only retention (90/365/400 d, §4.4). R2 spend protection wants an explicit
   per-run cap; propose `ACTIONS_ARTIFACT_MAX_RUN_BYTES` strict-polarity var
   (default: a 1 GiB run cap) enforced at upload-URL mint. No upstream answer
   exists; the var relaxes it to upstream's unlimited.
4. **Real-runner E2E posture in CI.** The acceptance bar (§6.5) needs act_runner
   + a container runtime in CI; our runners are container-less GitHub runners
   today. Working proposal: the fake-runner harness runs in CI (it IS the
   protocol oracle), the real binary gates releases manually. Revisit if
   act_runner grows a no-docker `--local` exec mode suitable for CI.

### Ratification (2026-10-29, orchestrator — pending)

This rewrite supersedes the 2026-10-24 gated draft. The gate's three criteria
are void per the Upstream-Parity Decision Rule (AGENTS.md:248-257): the
protocol is parity work (§1.1), the wire-freeze replaces the capture gate with
a hash-pinned fetch (§6.1), and demand ceases to be an entry criterion for
parity surfaces. Milestones M1a/M1b are dispatch-ready; M1c follows M1b; M2 is
docs-on-top; M3 waits on Open question 1.

### Ratification (2026-10-29, orchestrator)

The rewrite lifts the demand gate per the Upstream-Parity Decision Rule. The
four open questions resolve: (1) the expression evaluator is an M3-only
question (the trigger chain) — deferred to M3's opening, never blocking
M1a/b/c; (2) hand-rolled codec, frozen against the actionslib v1.5.0 source
at M1a's wire-freeze; (3) artifact quota: parity = no size cap (upstream caps
nothing), with a PACKAGES-style var as the self-host escape; (4) real
act_runner E2E stays OUT of CI — the fake-runner harness is the E2E; a real
runner smoke is M2 self-host docs material. M1a dispatched 2026-10-29.

## As-built — M1b (10cfb97, 2026-10-29 — the control plane is COMPLETE)

M1a landed first (32ef8bf, 2026-10-29: the wire freeze hash-verified against
actionslib v1.5.0, migration 0041's twelve tables, the four-procedure surface
+ interceptor over the hand-rolled codec, the dispatch CAS with the version
cascade, the harness at 61/61 — recorded in the specs index, abab71c). M1b
completes the ingestion half; every surface from UpdateTask onward serves:

- **UpdateTask** (`services/actions/update.ts`) — the state machine with the
  cancelling handshake, outputs' resend contract (§2.2's upsert-if-absent +
  caps + the `sent_outputs` echo), the reported-steps port with in-place
  relayout.
- **UpdateLog** (`services/actions/logs.ts`) — byte-for-byte: the
  `action_log_chunks` DBFS chunk store, the trim/ack/re-send/past-seal/
  gap-refusal branches §5.4 enumerates, the R2 seal via **multipart merge**
  (the workerd no-server-side-concat answer to §4.2's stream-merge proposal),
  the zigzag `LogIndexes` row→offset map.
- **Artifacts v1+v4** (`services/actions/artifacts{,-v1,-v4,-merge}.ts`) —
  md5-tee chunk streaming, the v4 blocklist replay with contiguous
  recomputation, HMAC signed URLs (§2.5's construction).
- **Job summaries** (`services/actions/summaries.ts`) and **the OIDC issuer**
  (`services/actions/oidc.ts` + `secrets.ts`) — RS256 WebCrypto,
  GitHub-shaped claims, the token_permissions grant gate (null permissions
  deny while the M3 parser is away — the v1 posture).
- **The fake-runner harness** (`services/actions/fake-runner.ts`) runs the
  FULL lifecycle as the standing E2E (§6.2's oracle, realized) — **168/168**
  across the actions family. The commit notes the rebuild's two self-caught
  bugs (Go-default claim field names; server-minted absolute URLs in the
  harness) and `insertActionRun` chunking at 2 rows per batch (the D1 bind
  cap).

Ledgered residuals: §4.6 entries 7 (the keystore-home divergence) and 8
(retention-var wiring, env-var caller pending).

## As-built — M1c (the UI family — the census units through b0e1d88)

The §2.10 census units landed across one window (all 2026-10-29), several
post-dating the §7 table:

- **C8 — a8e065f**: the repo Actions secrets/variables settings pair (the org
  twin's structure mirrored, the disabled-unit 404 polarity pinned; 59/59 +
  settings-family 246/246 + twins 300/300). The same three-unit window also
  carried the loginRedirect full-URI fix and the admin **packages** list page
  (SPEC-0016's admin row) — cross-SPEC riders, not M1c scope.
- **C9 — 6fcb561**: the Actions general settings page, upstream's gate
  verdict shipped exactly (the page + its unit-toggle POST sit OUTSIDE
  `MustEnableActions` per web.go:1262-1265's own comment — the disabled
  unit's re-entry; the bare `/settings/actions` redirect 303s to
  `./actions/general` INSIDE the gate; FormBool faithful). The
  token-permissions + collaborative-owners sections shipped
  documented-unrendered at 6fcb561 (the ActionsConfig store then needed its
  migration — cites pinned in the commit); RESOLVED as-built 97cb70e: the
  ActionsConfig store over `repo_units.config` (migration 0043 — nullable,
  NULL = upstream's nil-Config unit) serialized in upstream's exact
  Go-marshal RepoUnit.Config shape (`models/repo/repo_unit.go:32`,
  `repo_unit_actions.go:76-93` — CollaborativeOwnerIDs,
  TokenPermissionMode, MaxTokenPermissions, OverrideOwnerConfig, the
  workflow-disable maps), the two sections now rendering over the store
  and persisting through the page's POST arm; the column's lifetime rides
  the unit-toggle lockstep (the disable arm deletes the actions row,
  wiping config — upstream ActionsUnitPost's reset).
- **The five-family window — 0c8da44**: the Actions tab mounts. C1's runs
  list (the `?run_ids` partial-refresh fragment, MustBeNotEmpty + unit
  gates); C2's run-viewer subtree (the mount div + the ViewResponse JSON
  contract field-by-field vs view.go, the cancel CAS with the StopTask
  handshake, GET/POST resolution asymmetry); C6's job-queue pair (incl. the
  admin off-by-one parse fix and a real filterRepoId type bug); C7's runners
  settings; C9's arms fresh; C8's re-armed pins. The shell's Actions tab +
  repoHasActions threading + the admin nav's Actions group; ten admin
  goldens one-line each. Combined sweep **598/598**.
- **The writers fixes** — c1cefaa: the unit-row gap closed at the WRITERS
  (the scan was correct all along — the writers were the gap, C9's catch):
  `saveRepoSettings`, the single choke point both the UI toggle and the API
  PATCH funnel through, now writes the `repo_units` actions row in lockstep
  with `has_actions` in the SAME db.batch (upstream setting.go's
  UpdateRepositoryUnits shape; the unconditional direction write self-heals
  pre-fix stray rows). 42c2af7: the options form's `enable_actions` retires
  INCLUDING its SAVE arm — upstream's toggle lives only on
  actions_general.tmpl (options.tmpl's unit list ends at enable_pulls), and
  the pre-retirement absent-field-false parse would have clobbered
  `has_actions` to 0 on every ordinary options save; the new non-clobber arm
  pins the stored flag (the nav read rides `RepoBasicsData.hasActions`
  outside the form).
- **The creation-defaults flip — b0e1d88**: created repos arm per upstream's
  DefaultRepoUnits posture per creationKind (normal: actions + packages on;
  fork: both off per DefaultForkRepoUnits; mirror: packages on, actions
  off) — the flags AND the `repo_units` actions row seeded in the SAME
  creation batch, so they can never diverge; pre-flip repos untouched
  (creation-time writes only, upstream's shape). This is the posture M2's
  guide prose was corrected against.
- **The harvest-window closures (2026-10-30)** — the admin actions tails
  b5923ed (the survey's named opportunistic target: the admin runners
  family over the M1a store with upstream's ADMIN polarity — the empty
  cond lists EVERY runner, globals listed and editable — plus the global
  variables family and the bare group's relative 303; scoped-workflows an
  honest 404 with the nav item omitted); and the survey's F row COMPLETE
  1ff87d1: the F-row tail GETs all mounted — the job-scoped log download
  (raw bytes re-issued over M1b's chunk store/R2, the C2 read ladder), the
  run→workflow-file 303 (upstream's Base.Redirect), the shields-style
  badge.svg (both templates ported, anonymous-passing per the C1 ladder),
  and the dispatch-inputs HTML fragment (46/46 module + 327/327 sweep at
  landing).

**Still open (honest at this as-built read — updated 2026-10-30; the
original read was HEAD b7ef7e5):** C7's org-scope runners page
LANDED (3ab7532: the org Runners settings twin over the M1a store at the
(orgId, '') scope, the WithAvailable cond porting upstream's org polarity —
org's own + globals, a repo-scoped runner never lists in the org scope —
with the shared OrgSettingsNavbar's Runners sub-item lit). C3 (log
tail/steps) and C4 (artifacts preview UI + signed raw serving) LANDED in
cd7eec4 with the routes mounted in the SAME commit — the previewLink flip
went live beside the two index.ts route families (the repo preview subtree
and the viewer-less root signed-raw family; the HMAC is the auth), the
dead-link rule honored. The C4 census tails CLOSED: the per-name artifact
download/delete pair (GET+DELETE /actions/runs/{run}/artifacts/{name})
landed 6f07849 — the GET streams the confirmed row's stored content direct
from R2 (legacy families a composed zip), the DELETE the writer-gated
pending-deletion mark — and the F-row tail GETs landed 1ff87d1 (the
harvest-window bullet above). With those closures every M1c census unit is
LANDED except two, both M3-deferred: C5's rerun + rerun-failed DEFER to
M3's job emitter (the census's flagged split — attempt creation + job
re-emission are emitter territory; the cancel arm landed inside C2's
window) and C10's scoped-workflows pages defer with M3 (the census's own
defer note). M3 (the trigger chain) stays staged behind Open question 1 —
without it the control plane has no automatic producer, jobs arrive via
the test-harness insertion seams (§3's own sentence).

## As-built — M2 (0143e10, 2026-10-30)

`docs/guide/actions-runners.md` — 447 lines, every claim machine-checked
against the landed code (22 load-bearing cites spot-verified): what-works-
today (the four mount families, the wire freeze + divergences, interceptor
auth, the six-procedure table, token lifecycle, the dispatch payload,
ingestion); the act_runner recipe (install/register/labels with the
exact-match warning, an end-to-end walkthrough, the fake-runner as the
zero-install smoke — OQ-4's resolution exercised); the operator surface
(retention, secrets, variables); and seven honest limits. The draft's
pre-flip default-off prose was caught mid-flight and rewritten against
b0e1d88's creation-defaults flip — the guide's enable instructions reflect
the flipped posture.

## Decision record — Open question 1 resolved: the server/runner evaluation split (2026-10-31)

**Status: DECISION RECORD. No code is ratified here.** This resolves §8.1 as
written (text preserved above) and prices the consequences for M3's staging.
Cite conventions: upstream files are at the pin `fc493688` unless prefixed
`actionslib:` (the external `gitea.dev/actionslib v1.5.0`, `gitea/go.mod:11`,
read from the Go module cache copy hash-pinned per §6.1) or `cf-gitea:`.
Line counts are non-test, non-blank Go lines measured in that same copy.

### D1. The verdict

The board's framing ("upstream evaluates `if:`/concurrency/matrix expressions
with actionslib's Go `expreval`/`exprparser` — no JS equivalent") was right
about the dependency and wrong about the size of the question. Upstream's
server-side evaluation surface is **fixed and enumerable** — four
value-producing call-site families plus three AST-scan-only uses (§D2) — and
the environment each call site gets is **pinned by the server itself** to
github/gitea/needs/strategy/matrix/vars/inputs, with `env`, `job`, `steps`,
`runner`, and `secrets` deliberately nil (`modules/actions/jobparser/interpeter.go:43,47-50`
— the comment at `:13` reads "returns an interpeter used in the server, need
github, needs, strategy, matrix, inputs context only") and `WorkingDir` empty so
`hashFiles` self-disables server-side (`actionslib:pkg/exprparser/functions.go:477-479`
—"hashFiles is only available in steps"). Job `if:` is restricted further, to
`github, gitea, needs, vars, inputs`, by upstream's own static validation
(`modules/actions/jobparser/validate.go:20,54-59` — "which github.com decides
before the matrix, so without the matrix and strategy contexts",
`modules/actions/jobparser/model.go:490`).

The other half of the split: **the runner never evaluates anything job-level.**
The claim payload rewrites the job `if:` to the literal `always()` — "as Gitea
has decided it and a runner must not re-evaluate it"
(`services/actions/task.go:176-186`; cf-gitea's landed dispatch already stores
payload bytes verbatim with this rewrite staged, `cf-gitea:apps/worker/src/services/actions/dispatch.ts:12,345`).
All step-level expression work — step `if:`, `${{ }}` interpolation inside
`run:`/`with:`/`env:`, the `env`/`steps`/`runner` contexts, `hashFiles` —
belongs to act_runner's own embedded evaluator and never reaches the server.
This was observed live in our smoke: stock act_runner v0.2.13 logged
"evaluating expression 'success()'" for a **step** condition
(`docs/research/act-runner-smoke-2026-10-30.md:137-138`), while the same
payload's job decision had been made server-side before claim.

And the evaluator itself is **not** nektos/act's full engine: actionslib v1.5.0
ships gitea's own minimal rewrite — **13 built-in functions** total
(`case`, `format`, `join`, `contains`, `startsWith`, `endsWith`, `toJSON`,
`fromJSON`, `hashFiles`, `always`, `cancelled`, `success`, `failure`,
`actionslib:pkg/exprparser/interpreter.go:1053-1110`). OQ-1's premise "no JS
equivalent exists" stays true as a statement about drop-in libraries, but the
port is measured at ~3.7k lines of dependency-light pure Go (§D4) — bounded,
conformance-testable, and smaller than the SPEC's "largest single port cost"
framing (§2.9) assumed.

### D2. The server-side evaluation census (complete)

Every non-test caller of `expreval`/`exprparser`/jobparser evaluation in
upstream at the pin:

| # | Site | What it evaluates | Contexts in the env | When |
|---|------|-------------------|---------------------|------|
| 1 | Run-name interpolation — `modules/actions/jobparser/jobparser.go:103-106` | `workflow.run-name` string | github, vars, inputs (nil github in detection's validation pass) | insert (`services/actions/run.go:121-127`) and detection validation (`modules/actions/workflows.go:129-136` via `ValidateWorkflowContent` `:141-144`) |
| 2 | Static matrix combinations — `jobparser.go:112-126` (`Strategy.resolve`, `MatrixCombinations`, `buildMatrixCombos` `:225`) | combo `name:`/`runs-on:`/`continue-on-error:` `${{ }}` | github, vars, inputs + matrix values | insert, when the matrix reads no needs (`jobparser.go:65-67,112-126`) |
| 3 | Deferred-matrix placeholder detection — `HasDeferredMatrix` `jobparser.go:18-27` via `expressionReadsNeeds` `:65-67` | none — `expreval.ReadsContext` AST scan | — | parse time |
| 4 | Run-level concurrency — `EvaluateRunConcurrencyFillModel` (`services/actions/concurrency.go:19-46`) via `EvaluateConcurrency` (`model.go:315-337`) | workflow-level `concurrency.group/cancel` | + strategy, matrix (`newJobEvaluator` `model.go:297-303`) | insert (`services/actions/run.go:101`) |
| 5 | Job-level concurrency at insert — `EvaluateJobConcurrencyFillModel` (`concurrency.go:46-85`) called from `insertRunJob` (`services/actions/run.go:185,267`) | `jobs.<id>.concurrency.group/cancel` | + strategy, matrix | insert, for a job that can start immediately |
| 6 | Job-level concurrency at the emitter — `services/actions/job_emitter.go:690` | same | same | each emitter pass when needs finish |
| 7 | Deferred-matrix expansion — `expandDeferredMatrix` (`services/actions/matrix.go:43-204`, called `job_emitter.go:600`) via `ExpandMatrixWithNeeds` (`jobparser.go:165`) | matrix combos from needs' outputs ("strategy may reference the inputs context as well as needs", `matrix.go:89`) | + needs results, strategy, matrix | emitter pass |
| 8 | Job `if:` start-gate — `decideJobIf`/`resolveJobIf` (`services/actions/helper.go:133-150,174`) via `EvaluateJobIfExpression` (`model.go:490-497`) | `jobs.<id>.if` truth | github, gitea, needs, vars, inputs ONLY (validate.go:20) — `gitCtx["job"] = ""` (`helper.go:171`) | insert/emitter before a job starts; a false `if:` marks the job `StatusSkipped` (`helper.go:141-143`) |
| 9 | Static context validation — `unavailableContext` (`validate.go:63-78`; `validateJobConditions` `:54-59`; run-name `:47-50`) via `expreval.Match` (`actionslib:pkg/expreval/subexpr.go:56-65`) | none — AST named-value scan | — | **detection, on every trigger event** (`GetEventsFromContent` → `ValidateWorkflowStatic`, `modules/actions/workflows.go:123-135`); push additionally records each static-invalid workflow as a FAILED RUN with the parse error as its summary (`services/actions/invalid_workflow.go:20-46`, gated on push at `notifier_helper.go:284-286`), surfaced in the run list (`routers/web/repo/actions/actions.go:559-569`) |
| 10 | Cancel-arm function scan — `expreval.CallsFunction` (`services/actions/cancel.go:86-87`) | none — does the `if:` call `always()` but not `cancelled()` | — | cancel cascade |
| 11 | Dispatch-input coercion — `exprparser.CoerceToString` (`services/actions/workflow.go:213`) | string coercion of dispatch inputs | — | workflow dispatch |
| 12 | Workflow-call output evaluation — `EvaluateWorkflowCallOutputs` (`services/actions/context.go:285-290`; `actionslib:pkg/expreval/workflow_call.go`) | caller-side `outputs:` of a reusable callee | github, needs, vars, inputs | **v2-staged** (reusable workflows are out per §1.4) |
| 13 | Schedule static scan — `ValidateWorkflowStatic` (`services/actions/schedule_tasks.go:148`) | none — same scan as #9 | — | **M3-followup-staged** (§1.4 schedules) |

The full evaluator environment the server can ever populate is therefore:
`github`/`gitea` (the alias maps gitea→github, `actionslib:pkg/exprparser/interpreter.go:239-240`),
`needs` (from results), `strategy`+`matrix` (model.go:297-303), `vars`,
`inputs`. `env`/`job`/`steps`/`runner`/`secrets` are nil server-side forever
(interpeter.go:43,47-50); the full context registry is
`actionslib:pkg/exprparser/interpreter.go:238-257`.

### D3. The runner side (for the record)

The Task wire carries `WorkflowPayload` + `Context` + `Secrets` + `Vars` +
`Needs` (`services/actions/task.go:166-171`) — the runner rebuilds its own
environment from those plus its local `env`/`steps`/`runner`/`job` state and
evaluates everything below job level with act_runner's embedded (nektos/act)
evaluator. cf-gitea ships none of that: our claim payload already carries the
resolved, `always()`-forced single-job YAML (§2.3), so **the server-side
expression engine cf-gitea needs is bounded exactly by the census in §D2** —
nothing runner-side is ported, ever.

### D4. Re-pricing OQ-1's candidates (measured)

actionslib v1.5.0 non-test, non-blank lines (module-cache copy):

| Package | Lines | Server-relevant? |
|---------|-------|------------------|
| `pkg/internal/syntax` (lexer/parser/AST/ordinal/utf16) | 1,109 | **yes** — the grammar, and the scan API rides it |
| `pkg/exprparser` (interpreter/functions/json/object/memory/syntax) | 2,821 | **yes** minus `glob.go` (≈600) |
| `pkg/exprparser/glob.go` | ≈600 | **no** — `hashFiles`' filesystem matcher; its only non-test caller is `hashFiles` (`functions.go:492`), which the server never reaches (`functions.go:477-479`) |
| `pkg/expreval` (evaluator/subexpr) | 466 | **yes** minus `workflow_call.go` (≈120, v2-staged per §D2 #12) |
| `pkg/model` (workflow model) | 2,204 | yes — but this is the separately-recorded "YAML model port" M3 row, not the evaluator |
| in-tree `modules/actions/jobparser` (non-test) | 1,238 | yes — same, part of the model/parser port |

- **(b) full library port = ≈3.7k lines** of evaluator proper (1,109 + 2,224 +
  ≈346), no new JS deps (the only Go dep behind the dropped `glob.go` is
  doublestar, `gitea/go.mod:135` indirect). Conformance test data rides the
  module (`actionslib:pkg/exprparser/testdata/`, `pkg/model/testdata/`) — §6.4's
  differential plan absorbs it directly.
- **(a) hand-ported subset is REFUTED as a parity option.** Upstream restricts
  only CONTEXTS (validate.go:20,54-59), never grammar: a grammar subset would
  reject at insert expressions upstream accepts (a static-parse failure in
  `Parse` aborts `InsertRun` — "parse workflow: %w",
  `services/actions/run.go:121-123` — and no run is created,
  `notifier_helper.go:363-365`), a user-visible production divergence. Its
  other reading — "the contexts the server actually needs" — is vacuous: the
  server's context set is already minimal (§D2). Option (a) survives only as a
  documented-divergence staging posture (§D5), never as the M3 design.
- **(c) WASM** stays the escape hatch if the port overruns; not needed at this
  size.

**RESOLVED: OQ-1 closes as (b)-shaped** — port the evaluator core wholesale,
dropping `glob.go` (server-unavailable `hashFiles`) and `workflow_call.go`
(v2), with the environment table exactly as §D2 pins it. The §8.1 working
proposal "(a)" is retired by the evidence above, not by preference.

### D5. The M3 staging consequence (the decomposition the board carries)

Upstream's failure posture is now evidenced and it is **late, not insert-time**:
evaluation failures fail the JOB with a persisted `action_run_job_summary` row
("Error when evaluating `if` for job X", `helper.go:181-184`; the same for
`runs-on` `job_emitter.go:628` and `concurrency` `:637`) or terminal-fail it
(`matrix.go:52-71`); only static parse errors reject the whole run at insert
(run.go:121-123). Any staged subset must reproduce this posture, not invent an
insert-time rejection.

M3's content decomposes into three evaluator-independence tiers:

- **P — pure parity rows (no expression machinery at all):** the notifier
  census (35 hooks, cycle break, repo skips — `services/actions/notifier.go:41-784`,
  `notifier_helper.go:139-172`), `skipWorkflows` `[skip ci]` string scan
  (`notifier_helper.go:298-`; strings `modules/setting/actions.go:51`),
  workflow enumeration + the 1 MiB cap (`workflows.go:75-121`) + event
  extraction + the `workflowpattern` matchers (a glob package, expression-free —
  `workflows.go:390-465`), `InsertRun` mechanics + run numbering
  (`run.go:63-160`), the job emitter's needs-graph/slots/max-parallel/
  group-comparison (`job_emitter.go`, `services/actions/max_parallel.go`),
  commit statuses + the skipped-status arm (`services/actions/commit_status.go`),
  the claim-payload `if: always()` rewrite (task.go:176-186), harness wiring.
  This is the **majority of M3's listed content**, and it produces runs
  end-to-end for expression-free workflows — the plain push-CI case.
- **S — syntax-layer rows (the parser, no value evaluation):** detection-time
  static validation + the push invalid-workflow failed-run arm (§D2 #9 —
  `workflows.go:129-135`; `invalid_workflow.go:20-46`), deferred-placeholder
  detection (§D2 #3), the cancel scan (§D2 #10). These need
  `internal/syntax` (1,109 lines) + `expreval/subexpr.go`, not the interpreter.
- **E — evaluator rows (the interpreter core):** (E1) the core port
  (interpreter/functions/json/object/memory/syntax + the `expreval` evaluator,
  ≈2.6k lines) + conformance suite; (E2) run-name + static-matrix combos at
  insert (§D2 #1-2); (E3) the job `if:` gate + invalid-`if:` job summaries
  (§D2 #8); (E4) concurrency run+job (§D2 #4-6); (E5) deferred-matrix expansion
  (§D2 #7).

The honest staging limit, and why it is a limit rather than a stopping point:
without E, `Parse` cannot evaluate expression-ful run-names/matrices, so such
workflows insert no runs at all (run.go:121-123) — upstream inserts them.
Upstream itself gates "expression-ful" with a literal `${{` byte scan
(`workflows.go:134`), which is the same gate a P+S-only staging would lean on
to state its coverage ("workflows without `${{` run; others wait for E").
Dispatch may therefore split M3 into a P+S unit (covering expression-free
workflows, with the expression-ful gap documented per the SPEC-0005
visible-error discipline) and an E unit closing it; whether one L wave or two
is a dispatch call, not a design one. The §7 M3 row's **L** sizing holds; its
risk note changes from "port-fidelity risk" to "fidelity is
conformance-testable against actionslib's own testdata" (§D4).

**§D5 AS-BUILT (2026-10-31; the E-tier call-site wave + the E5 model-port
wave, same day).** All three tiers landed and wired, and the staged E5
block below closed: P (`0e9b0c1`), S (`667d349`), E core (`240d67d`), and the
call-sites in `cf-gitea:apps/worker/src/services/actions/trigger.ts`:

- **E2 (§D2 #1) run-name** — `insertTriggeredRunSplit` interpolates the raw
  `run-name` through `newServerInterpeter` (github/vars/inputs; no
  strategy/matrix/needs — jobparser.go:101's env) AFTER the run row insert
  so `github.run_id`/`run_number` are real (run.go:80-89's own order);
  `jobs[0].RunName != ""` lifts the title (run.go:121-127). An evaluation
  error aborts the insert with the upstream outcome (no run row) via a
  compensating delete + guarded counter rollback — the D1 substitute for
  upstream's single transaction. NOT wired with it: the combo
  name/runs-on/continue-on-error interpolation (§D2 #2) — those ride the
  matrix arm below; such jobs insert with the raw strings (documented).
- **E3 (§D2 #8) the job `if:` gate** — `decideJobIfAtInsert` (helper.go:132-144:
  waiting jobs only; empty → implicit success; false/invalid → SKIPPED) and
  the emitter gate in `checkJobsOfRun` (job_emitter.go:589-596) with
  `evaluateJobIfExpression` (model.go:489-498): the restricted-context
  defensive re-check + `EvalBool` under DefaultStatusCheckSuccess; needs
  results + outputs per `findJobNeedsAndFillJobResults` (helper.go:196-226);
  `gitCtx["job"] = ""` (helper.go:171). Invalid `if:` → the
  `upsertJobErrorSummary` row ("Error when evaluating `if` for job `X`",
  helper.go:152-156) + SKIPPED — the D5 "late, not insert-time" posture.
  A skipped/failed insert kicks the pass (run.go:172-178's
  needPostCommitEmit).
- **E4 (§D2 #4) workflow-level concurrency at run creation** — the raw
  node read (model.go:288-293 minus the model validation), the fill-model
  evaluation (concurrency.go:19-44: group/cancel over the string-level
  evaluator — exact on the two-scalar RawConcurrency shape,
  workflow.go:1201-1228; the bare scalar decodes as the RawExpression arm),
  the cancel arms (models/actions/run.go:407-426 + run_job.go:804-832:
  claimed jobs through the graceful StopTask handshake, unclaimed through
  the task_id=0 CAS with UpdateRunJob's refreshRunStatus piggyback,
  run_job.go:542), the block gate (clear_tasks.go:121-134), and the
  emitter's blocked-run re-check + wake arm (job_emitter.go:243-255,
  :181-234). **Job-level concurrency (§D2 #5-6) STAGES**: its
  `newJobEvaluator` (model.go:297-303) reads the parsed combo's
  strategy+matrix; the raw node stores (run.go:251-256) with
  `is_concurrency_evaluated=false`.
- **E5 (§D2 #7) deferred-matrix expansion — LANDED 2026-10-31 (the model
  port wave)**: the YAML workflow model lives in
  `apps/worker/src/services/actions/workflow-model/` (actionslib
  `pkg/model`'s matrix expansion + in-tree jobparser's Job/Strategy decode,
  `Strategy.resolve`, `MatrixCombinations`/`buildMatrixCombos`,
  `ExpandMatrixWithNeeds`) and expreval's `EvaluateYamlNode`
  (evaluator.go:96-260) landed in `expression-eval/evaluator.ts` — the seam
  its header recorded. `trigger.ts` wires it: the model split runs INSIDE
  `insertTriggeredRunSplit` after the run row exists (run.go:106-111's own
  order — github.run_id/run_number interpolate for real); a parse error
  aborts the insert with upstream's outcome (no run row, the compensating
  delete — "parse workflow: %w", run.go:121-123). Static combos insert one
  row per combination (job id, needs, the baked single-value matrix with
  job-index/job-total, the interpolated name/runs-on/continue-on-error with
  the runner's expression escapes, jobparser.go:225-274); a needs-reading
  matrix plans as the deferred placeholder (is_matrix_deferred +
  deferred_matrix_payload) and the emitter's expandDeferredMatrixOfJob
  (matrix.go:43-204) expands it over the completed needs — combination 0
  reuses the placeholder behind the (is_matrix_deferred, status) CAS claim,
  the siblings insert BLOCKED with fresh attempt_job_ids, and an expansion
  failure terminal-fails the placeholder (the D5 late posture,
  matrix.go:52-71). The job-level concurrency gate (§D2 #5-6) landed with
  it: the fill model evaluates at insert for a job entering its group
  (run.go:264-269 over EvaluateConcurrency, model.go:315-335) and at the
  emitter for a needs-blocked one (updateConcurrencyEvaluationForJobWithNeeds,
  job_emitter.go:684-702), PrepareToStartJobWithConcurrency cancels-or-
  blocks (clear_tasks.go:106-125), the admitted-group gate keeps a second
  entrant blocked (job_emitter.go:655-657), and checkRunConcurrency's full
  collection (run group + done jobs' evaluated groups) wakes the waiters.
  The insert-time max-parallel slot map (applyMaxParallel,
  max_parallel.go:74-79) and the runs-on schema arm (run.go:253-256 +
  invalidRunsOn, job_emitter.go:629-635) ride the same loop. The insert
  gate is UN-NARROWED: a `strategy.matrix` workflow flows end-to-end.
  Fixtures: pkg/model matrix_test.go's tables port row-for-row
  (workflow-model/matrix.test.ts, 33 rows); jobparser's testdata + test
  tables port in workflow-model/combos.test.ts (the comparison adapts from
  go-yaml's encoder bytes to semantic deep-equal — the payload-bytes
  deviation this SPEC already records); evaluator_test.go's
  TestEvaluateYamlNode rows live in expression-eval/expression-eval.test.ts.
  One byte divergence recorded there: this emitter renders float64 1e15 as
  "1000000000000000" where go-yaml writes "1E+15" — same parsed value,
  writing the Go-side coerced text instead would flip the parsed type.
- **Run numbering** — the HANDOFF closed: `repo_counters.run_index`
  (migration 0050, drizzle-generated) + `nextRunIndex` as the atomic
  counter CAS (bootstrap-at-max → never-rewind repair → bump+read, one D1
  batch = one transaction; the §4.5 mapping). The two max+1 writers outside
  the counter (invalid-workflow runs, repo-actions routes) keep
  UNIQUE(repo_id, index) as their backstop.

### D6. Downstream notes this record corrects or arms

- The board row P1-1's "OQ-1 sits in front of all of it" softens to "OQ-1's
  evaluator rows sit in front of the E tier only" — the P and S tiers are
  dispatchable without any §8.1 residue.
- P1-13's scoped-workflows staged arms (the parser's YAML half,
  `GetEventsFromContent`/`deriveScopedStatusContexts`) ride the **S tier**
  (`GetEventsFromContent` is cited in §D2 #9), not the E tier.
- The claim-payload rewrite (task.go:176-186) is a **P-tier row** — it needs
  the YAML model to re-serialize a stored payload (cf-gitea dispatch.ts:345
  already notes this), not the evaluator.
- The `[skip ci]` arm, cycle break, and commit statuses are **P-tier** with
  zero expression dependencies — no OQ-1 residue attaches to them.

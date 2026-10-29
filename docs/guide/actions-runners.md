# Self-hosting Gitea Actions runners against cf-gitea

SPEC-0012 M2 · 2026-10-29 · Audience: an operator running a deployed cf-gitea
instance who wants `act_runner` polling it for CI jobs.

**The security posture, up front**: cf-gitea never executes workflow steps —
no containers, no node runtimes, no `uses:` action downloads. Execution lives
entirely in the runner binary on YOUR machine (SPEC-0012 §1.4). The server's
job is the control plane: registration, dispatch, and the ingestion of logs,
artifacts, and statuses.

Status of the code this doc describes: the control plane is COMPLETE — M1a
(the runner protocol, registration, dispatch; commit `32ef8bf`) + M1b
(UpdateTask/UpdateLog/artifacts/summaries/OIDC ingestion; commit `10cfb97`).
The trigger chain (M3) is NOT landed: nothing creates runs from pushes yet
(§4.1). Every claim below is cited to the landed code.

Citation convention: bare `file.ts:N` cites resolve inside
`apps/worker/src/services/actions/` unless a fuller path is given. Upstream
`file.go:N` cites resolve inside the vendored `gitea/` Actions packages
(`routers/api/actions/`, `models/actions/`, `services/actions/`,
`modules/…`) — the READ-ONLY pin `fc4936884584`.

---

## 1. What works today

### 1.1 The control plane at a glance

Four mount families live in `apps/worker/src/index.ts`:

| Mount | Family | Where |
|---|---|---|
| `POST /api/actions/{service}/{Method}` | connect-RPC: PingService echo + RunnerService (Register/Declare/FetchTask/UpdateTask/UpdateLog) | index.ts:218 · routes.ts:67-68, 304-452 |
| `GET /api/actions/oidc/{…}` | the OIDC issuer (discovery, JWKS, token exchange) | routes.ts:301 · oidc.ts:264, 277, 282 |
| `/api/actions_pipeline/_apis/pipelines/…` | artifacts v1 + job summaries (Bearer runtime-token auth) | index.ts:224 · artifacts-v1.ts |
| `/twirp/github.actions.results.api.v1.ArtifactService/…` | artifacts v4 (twirp-style; HMAC-signed upload/download URLs) | index.ts:229 · artifacts-v4.ts:44 |

**Wire format**: connect unary over `application/proto` — the codec a stock
act_runner speaks. This is the hash-verified wire freeze of
`gitea.dev/actionslib` v1.5.0, equal to upstream's `go.sum` pin
(proto/WIRE-FREEZE.md:10-18; the `.proto` fixtures sit in `proto/`).
Documented divergences: the gRPC and gRPC-Web protocol variants are not
implemented, and an `application/json` connect request answers `unimplemented`
(WIRE-FREEZE.md:42-47; routes.ts:204-214). Response compression is not
implemented — runners advertising `Connect-Accept-Encoding` get identity
(WIRE-FREEZE.md:51-53).

**Runner authentication** (the interceptor, routes.ts:247-280): every
procedure except `Register` requires the `x-runner-uuid` + `x-runner-token`
headers (the actionslib protocol constants — WIRE-FREEZE.md:31-33). The token
is verified constant-time against the runner row's salted digest. Plain
handler errors reach the runner as connect `CodeUnknown` with upstream's exact
message strings (routes.ts:231-234; register.ts:67-70). Heartbeats are
debounced: `last_online` persists at most every 30 s, `last_active` (only on
the Update* family) every 5 s — "writing on every poll is a major source of DB
load" (routes.ts:263-275; the constants, model.ts:349-368, porting
runner.go:64, 66, 89-99).

### 1.2 The six procedures

| Procedure | Behavior | Code |
|---|---|---|
| `ping.v1.PingService/Ping` | Echo (`"Hello, <data>!"`) — the runner's connectivity probe (ping/ping.go:31-42) | routes.ts:304-312 |
| `RunnerService/Register` | The ONE unauthenticated procedure. Validates token+name, looks the registration token up by its RAW string, requires it active, verifies the scope's owner/repo exist, creates the runner (uuid, name ≤255, labels, version, ephemeral, `has_cancelling_support` iff capabilities contains `"cancelling"`), returns the runner's polling token | routes.ts:316-351 · register.ts:72-129 |
| `RunnerService/Declare` | Re-advertise labels/version/capabilities; answers the server capability header `X-Gitea-Actions-Capabilities: job-summary` (upstream runner.go:151-154; the value at register.ts:50) | routes.ts:354-385 |
| `RunnerService/FetchTask` | Answer-immediately poll (no held long-poll): compares the runner's `tasks_version` against the scope counter, bootstraps 0→1 on first sight, attempts a pick on mismatch, echoes the stale version when the per-isolate pick limiter throttles | routes.ts:387-403 · dispatch.ts:134-168 |
| `RunnerService/UpdateTask` | The job's terminal state machine + job outputs (upsert-if-absent; the response lists the keys actually stored so the runner resends the rest) + runner-reported steps (in-place relayout); recomputes the run/attempt aggregate; bumps `tasks_version` to wake other pollers; removes a finished ephemeral runner | routes.ts:408-431 · update.ts (header cites the port surface) |
| `RunnerService/UpdateLog` | The ack-index log protocol: rows the server holds are trimmed, a re-sent finalize is acked idempotently, appends past the seal answer `already_exists`, a `no_more` finalize with gaps is refused (a log never archives with holes); the seal stream-merges the hot chunks into one R2 object | routes.ts:433-452 · update.ts · logs.ts:1-13 |

### 1.3 Registration tokens: where they come from

The token the runner registers with lives in the `action_runner_tokens` D1
table (migration 0041), stored RAW (upstream parity — the runner's
post-registration polling token is the salted-hash one, and its plaintext is
returned exactly once at Register; model.ts:286-318).

Lifecycle (services/actions/model.ts):

- `newRunnerTokenWithValue` (model.ts:183-210) deactivates all same-scope
  active tokens, then inserts the new one — **a registration token is
  REUSABLE UNTIL RESET**: "reset" = mint-new-and-deactivate-old, so one
  active token registers a whole fleet (the SPEC's draft correction;
  register.ts:7-14).
- `getOrCreateActiveRunnerToken` (model.ts:257) — the UI's mint: reuse the
  latest token while it stays active, else mint.
- A token carries a SCOPE `(owner_id, repo_id)`: repo-scoped
  `(0, <repo-id>)`, owner-scoped `(<owner-id>, 0)`, global `(0, 0)`. The
  runner it registers inherits the scope and only ever sees jobs inside it
  (the waiting-job scan, model.ts:660).

**Where you can mint one today**: the repo-scoped UI only — repo
**Settings → Actions → Runners**, the registration-token panel with its
"Reset registration token" form POST
(`apps/worker/src/ui/pages/repo-settings-actions-runners.tsx:380`; the reset
arm, `apps/worker/src/ui/index.ts:6272`; the six routes,
repo-settings-actions-runners.tsx:39-49). The `/api/v1` registration-token
and runners-CRUD endpoints (SPEC-0012 §2.8) are NOT landed yet, and the
org-settings Actions page carries only the secrets+variables arms today —
no runners arm (`apps/worker/src/ui/pages/org-settings-actions.tsx:11-13`).
Owner-scoped and global tokens exist at the service layer
(model.ts:223, 257) but no UI/API surface mints them yet (§4.3).

### 1.4 Dispatch: how a job reaches a runner

1. **Poll** — the runner sends `FetchTask{tasks_version}` every couple of
   seconds. The server answers immediately from D1 (no DO, no websockets;
   SPEC-0012 §4.5). First sight of a scope bootstraps its version counter
   0→1 (dispatch.ts:141-147, runner.go:179-187's port).
2. **Pick** — on a version mismatch the server scans the scope's waiting jobs
   oldest-first and label-matches (model.ts:660; the label rule, §2.4). A
   per-isolate semaphore caps concurrent picks at 16 (dispatch.ts:80-105;
   the documented per-isolate divergence of upstream's process semaphore,
   dispatch.ts:82-86).
3. **Claim** — a conditional UPDATE, `task_id = 0 AND status = waiting`, one
   row or the race is lost and the scan advances (dispatch.ts:264-281). A
   task row is created with a fresh salted polling token (dispatch.ts:239-261)
   and the log filename derived from the repo's full name
   (dispatch.ts:284-294). A failed payload assembly releases the claim
   (dispatch.ts:204-211; model.ts:731).
4. **Payload** — `buildRunnerTask` (dispatch.ts:320-354) hands the runner:
   - `workflow_payload` — the job's stored single-job YAML, **verbatim**
     (the `if: always()` claim-time rewrite is staged for M3's parser —
     dispatch.ts:12-15, 345-347);
   - `context` — the `gitea`/`github` context (GenerateGiteaContext port:
     refs, sha, event payload, `api_url`, `server_url`, `run_id`,
     `run_number`, … — dispatch.ts:372-474) plus `token` (the task polling
     token) and `gitea_runtime_token` (the HS256 runtime JWT for
     artifacts/summaries/OIDC — dispatch.ts:457, secrets.ts:236), plus the
     OIDC request pair when the job's stored token permissions grant
     `id-token` (dispatch.ts:462-472);
   - `secrets` — `GITHUB_TOKEN`/`GITEA_TOKEN` always; owner secrets overlaid
     by repo secrets; fork-PR runs get nothing else (except
     `pull_request_target`) — dispatch.ts:483-507;
   - `vars` — global → owner → repo, later scope wins (dispatch.ts:513-533);
   - `needs` — each needed sibling job's outputs + terminal result
     (dispatch.ts:541-571).

### 1.5 Ingestion: what comes back

- **Logs** — rows stream through `UpdateLog` into the `action_log_chunks`
  hot store (upstream's DBFS, mapped onto D1), then seal on `no_more` into
  the R2 object `actions/logs/<log_filename>`. Sealed logs are stored
  UNCOMPRESSED (upstream's `LOG_COMPRESSION=none` shape; zstd is not a
  Workers primitive) — logs.ts:1-13, SPEC-0012 §4.6 divergence 1. Lines are
  `"<RFC3339 7-digit UTC> <content>\n"`, content truncated at 64 KiB
  (logs.ts:18, 40-48).
- **Artifacts v1** — the azure-pipeline-flavored family: POST upload URL →
  chunked PUTs (`content-range` + per-chunk md5) → PATCH confirm → merge
  into `actions/artifacts/<run_id>/<artifact_id>` in R2 via a single-request
  multipart stream-merge (workerd has no server-side R2 concatenation).
  artifacts-v1.ts + artifacts-merge.ts.
- **Artifacts v4** — the actions-toolkit family: `CreateArtifact` →
  `comp=block` PUTs → `comp=blocklist` → `FinalizeArtifact`; downloads via
  HMAC-signed URLs (60-minute expiry, verified at artifacts-v4.ts:224,
  342-343). Body protojson capped at 1 MiB — only the signed URLs carry bulk
  bytes. artifacts-v4.ts.
- **Job summaries** — `GITHUB_STEP_SUMMARY` markdown PUT per step, 1 MiB
  caps; advertised to runners through the Declare capabilities header
  (summaries.ts; register.ts:50).
- **OIDC** — `/.well-known/openid-configuration`, `/jwks`, and `/token`
  (a token exchange, not OAuth2: the bearer is the claim-time
  `Actions.IDTokenRequest` JWT). ID-token claims mirror GitHub's, including
  `runner_environment: "self-hosted"` (oidc.ts:1-20, 264-282).

---

## 2. The self-host recipe

### 2.0 Prerequisites

- A deployed cf-gitea instance reachable over HTTPS from the runner machine
  (the runner polls; no inbound connectivity is needed).
- Admin/owner access to a repository on it.

### 2.1 Enable Actions on the repository

New repositories created the ordinary way have Actions ARMED at creation —
the 2026-10-29 upstream-parity flip of the creation defaults
(`apps/worker/src/repos/service.ts:315-317`: normal creates arm actions +
packages, forks arm neither, mirrors arm packages only; the flag and the
`repo_units` actions row are seeded in the same creation batch,
repos/service.ts:363). Two caveats:

- **Repos created before the flip are untouched** — creation-time writes
  only. Their `repo_settings` row carries `has_actions = 0` (or no row; the
  missing-row fallback stays the pre-flip posture,
  `apps/worker/src/api/services/repo-settings.ts:23-35`). Turn those on via
  either path below.
- The schema column default is still false (`apps/worker/src/db/schema.ts:1323`);
  only the creation writer arms it.

Turn Actions on for an un-armed repo either way:

- **UI**: repo **Settings → Actions → General** → the "Enable Actions"
  toggle → POST `.../settings/actions/general/actions_unit`
  (apps/worker/src/ui/pages/repo-settings-actions-general.tsx header; the
  route family, apps/worker/src/ui/index.ts:1806-1811). The page
  deliberately renders while the unit is disabled — it is the disabled
  unit's re-entry (upstream web.go:1262-1265's posture).
- **API**: `PATCH /api/v1/repos/{owner}/{repo}` with `has_actions: true`
  (`apps/worker/src/api/routes/repo.ts:583`).

Once enabled, the repo grows the **Actions** tab
(`apps/worker/src/ui/shell.tsx:355`).

### 2.2 Mint the registration token

Repo **Settings → Actions → Runners** → copy the **Registration Token** from
the header panel. Notes:

- The token is repo-scoped: a runner registered with it serves only this
  repo. Register as many runners as you like with the same token — it stays
  active until you click **Reset registration token**, which invalidates it
  (minting a fresh one) but does NOT touch already-registered runners
  (§1.3; upstream's reset semantics, runner_token.go:74-98).
- Losing the token page is fine — the panel always shows the current active
  token (`GetOrCreateActiveRunnerToken` reuses it).

### 2.3 Install act_runner

The stock, unmodified runner is upstream's `act_runner`. cf-gitea implements
exactly the protocol it speaks (the actionslib v1.5.0 wire freeze, §1.1).

- **Binaries**: <https://dl.gitea.com/act_runner/> — the classic 0.2.x line
  (newest 0.2.13) is the line cf-gitea's control plane targets.
- **Docker**: image `gitea/act_runner` (bind `/var/run/docker.sock` and keep
  the `.runner` file + working dir on a volume).
- Upstream docs: <https://docs.gitea.com/usage/actions/act-runner> (install,
  registration, config reference).
- The successor `gitea/runner` line (the renamed repo, versions 5.x, also on
  dl.gitea.com) is NOT yet verified against cf-gitea — pin 0.2.x until it is.

The runner needs a Docker-compatible runtime for `docker://` labels (or use
`host` labels on a trusted machine — upstream's warning applies: host jobs
run as the runner's user with no isolation).

### 2.4 Register — point the runner at your instance

Interactive:

```sh
./act_runner register
# Gitea instance URL: https://your-instance.example.com
# Registration token: <paste from §2.2>
# Runner name: my-runner
# Labels: ubuntu-latest
```

Non-interactive (the env-var spelling — `GITEA_INSTANCE_URL` is how the
instance URL reaches the runner; `GITEA_RUNNER_REGISTRATION_TOKEN` carries
the token):

```sh
GITEA_INSTANCE_URL=https://your-instance.example.com \
GITEA_RUNNER_REGISTRATION_TOKEN=<token> \
./act_runner register --no-interactive --name my-runner --labels ubuntu-latest
```

Success writes the credentials to a local `.runner` file (uuid, token,
address, labels) and the runner appears in Settings → Actions → Runners.

**Labels — read this twice.** The label grammar is
`name[:schema[:args]]` — e.g.
`ubuntu-latest:docker://gitea/runner-images:ubuntu-latest` means "the label
`ubuntu-latest` runs jobs in that container image"; `host` (or a bare name)
runs jobs directly on the runner machine. act_runner registers the LABEL
NAMES with the server (the schema part stays in the runner's local config as
the execution environment). The server then matches a job's `runs-on:`
values against those registered names EXACTLY — case-insensitive, every
label must be present, and an empty `runs-on` never matches (model.ts:371-377,
porting upstream runner.go:202-205). Consequences:

- Register the names your workflows will write in `runs-on:`. If the job's
  full label list is not covered by one runner, the job stays WAITING — it
  does not fail; it waits for a matching runner to poll.
- Keep the `docker://` image mapping in the runner's own `--labels`/
  `runner.labels` config; only the name before the colon reaches cf-gitea.
- `--ephemeral` registers a one-shot runner (one task per lifetime — the
  runner row is deleted after its task finishes; dispatch.ts:179-197). Pairs
  with disposable CI containers.

### 2.5 Run

```sh
./act_runner daemon
```

The runner works without a config file; `./act_runner generate-config`
writes a commented default (tune `runner.capacity`, `runner.timeout`,
`runner.fetch_interval`, container options). A stock default config's
GITEA-side settings need nothing beyond the instance URL already baked into
`.runner`.

### 2.6 What a job looks like, end-to-end

**Today runs are seeded through the service seam — a push does not create
them yet (§4.1).** The seed is `insertActionRun(d1, run, jobs)`
(model.ts:493): one run row + its attempt-1 + the job rows, each job
carrying its `runs_on` list and its single-job YAML `workflow_payload`. The
exact shape the standing tests seed (routes.test.ts:106-168):

```yaml
name: ci
jobs:
  build:
    if: always()
    steps:
      - run: echo hi
```

seeded as a run on `refs/heads/main`, event `push`, with the job
`jobId: "build"`, `runsOn: ["ubuntu-latest"]`. `insertActionRun` bumps the
scope `tasks_version` counters, so any polling runner picks the job up on
its next poll (dispatch.test.ts:266).

The runner then experiences: claim (`FetchTask` returns the full Task) →
steps execute locally → log rows stream via `UpdateLog` (acked, trimmed,
finalized) → `UpdateTask{state: SUCCESS, outputs}` commits the result →
artifacts/summaries upload via the runtime token → the run shows on the
repo's Actions tab (the runs list, `apps/worker/src/ui/pages/repo-actions-runs.tsx`,
derives the displayed run status by rolling up its jobs) and the runner's
heartbeat shows in Settings → Actions → Runners.

### 2.7 Zero-install smoke: the fake-runner harness

Before (or instead of) installing a real runner, you can drive the whole
lifecycle with the repo's own harness — no runner install, no docker.

- **What it is**: `apps/worker/src/services/actions/fake-runner.ts` — a
  Node/fetch client speaking the REAL connect/proto routes over HTTP. It
  never imports the server's service layer, only the frozen wire codecs both
  sides compile against (fake-runner.ts:17-19). It implements act_runner's
  client behaviors: the tasks_version poll cache (fake-runner.ts:230-238),
  the pending-log buffer with ack/trim bookkeeping (fake-runner.ts:287-318),
  artifacts v1 and v4 round trips (fake-runner.ts:373-415, 456-564), job
  summary PUT (fake-runner.ts:567-576), and the OIDC exchange
  (fake-runner.ts:579-585).
- **How it runs**: as the standing E2E inside the vitest suite —
  `@cloudflare/vitest-plugin` boots the MOUNTED app in workerd with real
  bindings, and the harness drives `SELF.fetch` against it
  (routes.test.ts:59-78). Run it:

  ```sh
  cd apps/worker
  pnpm test src/services/actions/routes.test.ts
  ```

  That single file walks ping → register → declare → FetchTask semantics →
  a seeded claim → UpdateLog ack/trim/resend arms → UpdateTask+outputs →
  the artifact families → summaries → OIDC (routes.test.ts:1-17). The
  sibling suites complete the family — `ingest.test.ts`,
  `artifacts.test.ts`, `wire.test.ts`, `dispatch.test.ts`, `model.test.ts`
  — 168/168 across the actions family at the M1b landing (10cfb97).
- **Against a live dev server**: the class is importable — point
  `new FakeRunner({ baseUrl })` at `pnpm dev`'s workerd URL, mint a token
  from the UI (§2.2), and replay the same calls in a scratch script. The
  module lives under `src/` as test infrastructure, not a shipped CLI.

---

## 3. Retention, secrets, and variables (operator surface today)

- **Secrets / variables** — the `/api/v1` family landed for all three
  scopes (`apps/worker/src/api/routes/secrets-variables.ts`): repo
  `/repos/{owner}/{repo}/actions/secrets|variables`, org and user twins.
  Whatever you store there rides the claim payload (§1.4).
- **Retention** — upstream defaults are artifacts 90 d / logs 365 d / runs
  400 d; cf-gitea's sweep implements the arms but the env vars are not wired
  and no scheduler calls it yet (§4.4). Practically: everything uploaded
  today persists until the sweep is wired.
- **Zombie tasks** — a task whose runner dies mid-run is only reaped by the
  (unwired) sweep arm `stopZombieTasks` (retention.ts:158-180); until then a
  dead runner's task stays RUNNING on the books. Cancel it from the run
  viewer instead (the run-viewer cancel POST, apps/worker/src/ui/pages/repo-actions-view.tsx).

---

## 4. Honest limits (read before promising CI)

1. **The trigger chain (M3) is not landed.** Nothing watches pushes, PRs, or
   releases: no workflow detection, no run/job creation, no commit statuses,
   no `[skip ci]`, no `workflow_dispatch`, no schedules. `FetchTask` answers
   faithfully — but only when a waiting job EXISTS (dispatch.ts:6-11; SPEC-0012
   §3). Today runs arrive exclusively through the service seam
   (`insertActionRun`, model.ts:493) — tests, the harness, or a script you
   write against a dev instance.
2. **Staged arms inside the claim payload.** The job's stored YAML is handed
   over verbatim (no server-side `if: always()` rewrite — the server-side
   decision model still holds, the rewrite needs M3's YAML parser;
   dispatch.ts:12-15, 345-347). No step rows exist at claim (the runner's
   own reported steps land via `UpdateTask` — dispatch.ts:21-22).
   `ref_protected` is always `false` (the protected-branch match service is
   M3 — dispatch.ts:429-430).
3. **The `/api/v1` registry family is partial.** Landed: secrets +
   variables (`apps/worker/src/api/routes/secrets-variables.ts`).
   Not landed: `POST .../actions/runners/registration-token`, runners
   CRUD, runs/jobs listing, workflows enable/disable (SPEC-0012 §2.8).
   Token minting is therefore UI-only, repo-scoped, today (§1.3) —
   owner-scoped and global tokens exist at the service layer
   (model.ts:223, 257) with no minting surface.
4. **Retention vars are unwired.** `ACTIONS_{ARTIFACT,LOG,RUN}_RETENTION_DAYS`
   are read NOWHERE from the environment; the sweep takes the knobs as
   parameters (retention.ts:39-58) and no cron producer/consumer calls it.
   A per-upload `?retentionDays=` on the v1 family is honored
   (artifacts-v1.ts:312-317) but there is no default ceiling —
   `expired_unix = 0` means keep forever (artifacts.ts:91-104).
5. **The keystore.** The instance's signing material — the HS256 token-signing
   secret (runtime JWTs, v4 HMAC) and the RS256 OIDC private JWK — is
   auto-generated on first use into the private R2 object
   `actions/_keystore/instance.json` (secrets.ts:31 and the module header,
   7-13). This is a documented divergence from SPEC-0012 §4.4 (which wants a
   `wrangler secret` + an encrypted D1 keystore); the function seam
   (`loadKeystore`) is the swap point. Consequences for operators: the
   material is never rotated by code, and deleting the object mints fresh
   material — in-flight signed URLs and OIDC trust from before the reset
   break (registered runners are unaffected; they re-auth normally).
6. **Wire divergences.** connect unary over `application/proto` only — no
   gRPC/gRPC-Web protocol variants, `application/json` answers
   `unimplemented` (WIRE-FREEZE.md:42-47; routes.ts:204-214). No response
   compression (WIRE-FREEZE.md:51-53). Sealed logs uncompressed (§1.5).
   The pick limiter is per-isolate, not per-process (dispatch.ts:82-86) —
   safe (the claim CAS is the correctness mechanism), just less damped.
7. **Untested runner lines.** The classic act_runner 0.2.x line is the
   verified target (the wire freeze is its protocol). The successor
   `gitea/runner` 5.x line is unverified — treat §2.3's pin as the
   compatibility statement until a real-binary smoke lands (SPEC-0012 §6.5
   keeps the real-runner E2E as a manual/release gate, not CI).

---

## 5. Sources

- Landed code: the `apps/worker/src/services/actions/` family, the mounts in
  `apps/worker/src/index.ts`, the UI pages under
  `apps/worker/src/ui/pages/`, as cited per section.
- SPEC-0012 (`specs/0012-actions-feasibility.md`) — the protocol surface
  (§2), data model (§4), milestones (§7), divergence ledger (§4.6).
- Wire freeze: `apps/worker/src/services/actions/proto/WIRE-FREEZE.md` and
  the `.proto` fixtures beside it.
- Upstream runner docs:
  [docs.gitea.com — Act Runner](https://docs.gitea.com/usage/actions/act-runner);
  the runner repo `gitea.com/gitea/act_runner` (renamed
  `gitea.com/gitea/runner`); binaries at <https://dl.gitea.com/act_runner/>.
  Label grammar and register behavior per the upstream README and the
  runner's `pkg/runner/labels.go` in the 0.2.x line (its `ParseLabels`
  strips the schema, so the bare label NAMES are what reach the server).

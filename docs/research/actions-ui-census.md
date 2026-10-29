# Actions UI census — research for the M1c wave

Date: 2026-10-29 · Provenance: upstream Gitea pinned at `fc4936884584a41931906553d96c2601d750e6ef` (read-only submodule), our repo at the time of writing.
Feeds: SPEC-0012 §2.10 (the UI family census) and §7's M1c row. Written while actions-M1a (control-plane core) is in flight, so M1c can dispatch the moment M1a/M1b land.

Companion reading: SPEC-0012 (wire protocol, D1 schema §4.1, R2 layout §4.2–4.3), SPEC-0008 (the Hono JSX + official-bundle posture), SPEC-0010 (session posture).

## 0. The two posture facts that shape all of M1c

1. **We render Hono JSX, not Go templates.** Our pages live under `apps/worker/src/ui/pages/*.tsx` and must reproduce the official templates' DOM contract (element ids, `data-global-init` hooks, `data-*` attributes) so the unmodified official bundle's JS enhances them (SPEC-0008). The shared-shell integration points (`ui/index.ts` route arms, `ui/links.ts`, locale) are orchestrator-owned shared files.
2. **The run viewer is 100% official-bundle JS.** Upstream SSRs only a two-attribute shell (`view_component.tmpl` → `<div id="repo-action-view" data-job-id data-actions-view-url data-locale-*>`); everything else — the jobs sidebar, the workflow graph, the log viewer with ANSI + `::group::` command parsing, artifacts panel, polling — is the vendored Vue app (`web_src/js/components/RepoActionView.vue` 570 L, `ActionRunJobView.vue` 820 L, `ActionRunSummaryView.vue` 254 L, `WorkflowGraph.vue` 720 L, `ActionRunView.ts` 215 L, wired by `web_src/js/features/repo-actions.ts`). M1c's job for that page is **one SSR shell + one JSON endpoint**, not a UI port.

**Already landed in our tree (do not re-do):** org settings Actions secrets + variables arms (`ui/pages/org-settings-actions.tsx`, wave 59) and user settings variables (`ui/pages/user-settings-variables.tsx`, wave 58) + user settings secrets. Their headers document the exact mounting posture (resolveOrgForRequest / requireOrgOwnership gates, sameOriginGuard form posts, 303-on-success). M1c extends this family, it does not start it.

Upstream also ships a devtest harness for the SPA: `POST /devtest/repo-action-view/runs/{run}…` (`MockActionsRunsJobs`, `routers/web/devtest/mock_actions.go:122`) — the frontend can be exercised with zero backend data. Useful as a golden source for the `ViewResponse` shape.

## 1. Route census (upstream, `routers/web/web.go` at the pin)

### 1.1 The repo Actions tab — group `/{username}/{reponame}/actions` (web.go:1566–1608)

Group middleware: `optSignIn, context.RepoAssignment, repo.MustBeNotEmpty, reqRepoActionsReader, actions.MustEnableActions`. Handlers in `routers/web/repo/actions/` (9 files, ~2.5k LOC): `actions.go` (769), `view.go` (1477), `view_artifact.go` (484), `badge.go` (65), `job_queue.go` (55).

| Route | Handler | Output | Extra auth |
|---|---|---|---|
| `GET /actions` | `actions.List` | full page `repo/actions/list`; **partial refresh**: with `?run_ids=…` re-renders only `repo/actions/runs_list` | — |
| `GET /actions/job_queue` | `actions.JobQueue` | full page `repo/actions/job_queue`; with `?refresh=1` only `shared/actions/job_queue_list` | — |
| `POST /actions/disable` / `/enable` | `DisableWorkflowFile` / `EnableWorkflowFile` | 302 back to the filtered list URL | `reqRepoAdmin` |
| `POST /actions/run` | `Run` | workflow dispatch | `reqRepoActionsWriter` |
| `GET /actions/workflow-dispatch-inputs` | `WorkflowDispatchInputs` | fragment `repo/actions/workflow_dispatch_inputs` (fetched on ref change) | `reqRepoActionsWriter` |
| `POST /actions/approve-all-checks` | `ApproveAllChecks` | JSON | `reqRepoActionsWriter` |
| `GET+POST /actions/runs/{run}` | `View` / `ViewPost` | `repo/actions/view` SSR shell / `ViewResponse` JSON | — |
| `GET+POST /actions/runs/{run}/attempts/{attempt}` | `View` / `ViewPost` | same | — |
| `GET+POST /actions/runs/{run}/jobs/{job}` | `View` / `ViewPost` | same | — |
| `POST /actions/runs/{run}/jobs/{job}/rerun` | `Rerun` | JSON | `reqRepoActionsWriter` |
| `GET /actions/runs/{run}/jobs/{job}/logs` | `Logs` | zip download (`common.DownloadActionsRunJobLogsWithID`) | — |
| `GET /actions/runs/{run}/workflow` | `ViewWorkflowFile` | 302 to `src/commit/{sha}/{path}` (scoped runs: `viewScopedWorkflowFile`) | — |
| `POST /actions/runs/{run}/cancel` | `Cancel` | JSON | `reqRepoActionsWriter` |
| `POST /actions/runs/{run}/approve` | `Approve` | JSON | `reqRepoActionsWriter` |
| `POST /actions/runs/{run}/delete` | `Delete` | JSON (refuses non-done runs) | `reqRepoActionsWriter` |
| `POST /actions/runs/{run}/rerun` | `Rerun` | JSON | `reqRepoActionsWriter` |
| `POST /actions/runs/{run}/rerun-failed` | `RerunFailed` | JSON | `reqRepoActionsWriter` |
| `GET /actions/runs/{run}/artifacts/{artifact_name}` | `ArtifactsDownloadView` | v4 single file raw; v1–v3 gzipped-on-store files zipped on the fly | — |
| `DELETE /actions/runs/{run}/artifacts/{artifact_name}` | `ArtifactsDeleteView` | JSON | `reqRepoActionsWriter` |
| `GET /actions/artifacts/{artifact_id}/preview` and `/preview/*` | `ArtifactsPreviewView` | page `repo/actions/artifact_preview` | `reqSignIn` (user-generated HTML under instance domain) |
| `GET /actions/workflows/{workflow_name}/badge.svg` | `GetWorkflowBadge` | `shared/actions/runner_badge_flat[-square]` svg | basic/OAuth2 auth allowed |

### 1.2 Root-level (no session)

- `GET /-/actions/artifacts/{artifact_id}/{expires}/{signature}/*` → `ArtifactsPreviewRawView` (web.go:293) — the sandboxed iframe sends no cookies; access is the HMAC `(artifact_id, expires, signature)` triple, size-capped by `ARTIFACT_PREVIEW_MAX_SIZE` (default 10 MiB, `modules/setting/actions.go:47,56`).

### 1.3 Settings pages (shared handler builders, `routers/web/shared/actions/`, 6 files ~1.4k LOC)

Shared builders in web.go:489–522: `addSettingsVariablesRoutes`, `addSettingsSecretsRoutes` (repo_setting arm), `addSettingsRunnersRoutes`, `addSettingsScopedWorkflowsRoutes`. Mounted at four scopes, all behind `actions.MustEnableActions`:

- **Repo** `/{owner}/{repo}/settings/actions…` (web.go:1262–1277): `GET /settings/actions` → LocationRedirect `./actions/general`; `/actions/general` GET+POST (`repo_setting.ActionsGeneralSettings` / `ActionsUnitPost` — the unit toggle group at web.go:1262–1265 deliberately sits **outside** `MustEnableActions` so you can re-enable a disabled unit); `/actions/general/collaborative_owner/add` + `/delete`; `/actions/general/token_permissions` POST (`UpdateTokenPermissions`); plus runners / secrets / variables groups.
- **Org** `/{org}/settings/actions…` (web.go:1051–1061): redirect → general; `/actions/general` GET+POST (`shared_actions.GeneralSettings` / `UpdateGeneralSettings`); runners; secrets; variables; scoped-workflows.
- **User** `/user/settings/actions…` (web.go:721–731): same shape as org (general, runners, secrets, variables, scoped-workflows).
- **Admin** `/admin/actions…` (web.go:898–904): `GET /admin/actions` → LocationRedirect `./actions/runners`; runners group + `POST /actions/runners/bulk` (`RunnerBulkActionPost`); variables; scoped-workflows; `GET /actions/job_queue` (`shared_actions.JobQueue`, template `admin/actions`).

Scope dispatch inside the shared handlers: `getRunnersCtx` / `getVariablesCtx` / `getScopedWorkflowsCtx` branch on `ctx.Data["PageIsRepoSettings"|"PageIsOrgSettings"|"PageIsUserSettings"|"PageIsAdmin"]` (runners.go:49–99, variables.go:39–81) — the same handler serves four scopes; our JSX pages already use one page module per scope instead.

### 1.4 Mail (rides M3, listed for completeness)

`templates/mail/repo/actions/workflow_run.tmpl` (+ `.devtest.yml` fixture) via `services/mailer/mail_workflow_run.go:28` — triggered by the notifier arm, not the UI wave.

## 2. Template census + what rides the bundle JS vs SSR

### 2.1 Repo Actions tab (`templates/repo/actions/`, 10 files)

| Template | Role | SSR vs JS |
|---|---|---|
| `list.tmpl` | Tab shell: sidebar + filter menu (actor/status/branch dropdowns) + dispatch banner/modal + runs list + pager + status-badge modal | SSR; bundle JS: `initWorkflowBadgeForm` (badge URL recalc on branch change), Fomantic dropdowns, `link-action` confirm modals |
| `runs_list.tmpl` | The run rows; **also the partial-refresh fragment** (`data-global-init="initActionRunsList"`, `data-action-runs-refresh-link/-interval`, `data-morph-whole` rows) | SSR fragment; JS: timer `GET` + `morphElementWithProtection` outerHTML morph (`repo-actions.ts:123–137`) |
| `sidebar.tmpl` | All-workflows nav: parsed workflows (+validation error icons, disabled labels), scoped-workflow groups (details/summary), other-workflows group, job-queue link | SSR |
| `no_workflows.tmpl` | Empty state | SSR |
| `workflow_dispatch.tmpl` + `workflow_dispatch_inputs.tmpl` | "Run workflow" modal; branch/tag selector; inputs form. The inputs fragment is re-fetched per ref (`data-fetch-url` on the branch dropdown) | SSR + `form-fetch-action` JS |
| `view.tmpl` | Run-viewer page shell: header + `view_component` | SSR (shell only) |
| `view_component.tmpl` | `<div id="repo-action-view" data-job-id data-actions-view-url + ~60 data-locale-*>` — the Vue mount point; **every string the SPA shows is injected here as a data attribute** | SSR mount point; all rendering is bundle Vue |
| `job_queue.tmpl` | Repo job-queue shell (sidebar + shared fragment) | SSR |
| `artifact_preview.tmpl` | Sandboxed-iframe file browser: file tree (`ArtifactPreviewFile` depth/selected), preview content, download button | SSR (fetches raw bytes via the signed root route) |
| shared: `repo/icons/action_status.tmpl` | Status icon used by list, queue, filters | SSR |

### 2.2 Settings / admin shells

- `templates/repo/settings/actions.tmpl`, `org/settings/actions.tmpl`, `user/settings/actions.tmpl`, `admin/actions.tmpl` — four `PageType` switchyards over the SAME shared partials: `shared/actions/runner_list.tmpl`, `runner_edit.tmpl` (+ `permission_mode_select`, `permissions_table(+unit)`, `owner_general_settings`, `scoped_workflows`), plus `shared/secrets/add_list.tmpl` and `shared/variables/variable_list.tmpl` (outside `shared/actions/` but part of the family).
- Bundle JS hooks on these pages: `initRepoActionsPermissionsForm` (`web_src/js/features/common-actions-permissions.ts`), `initSearchRepoBox` + `initScopedWorkflowRequired` + `form-fetch-action` (scoped-workflows page), Fomantic dropdowns/checkboxes.

### 2.3 Bundle-side data flow to implement (the wire contract)

- **Run viewer polling** (`ActionRunView.ts`): `POST {ActionsViewURL}` with JSON `{logCursors: [{step, cursor, expanded}]}` → `ViewResponse` JSON; timer re-POSTs while `!state.run.done`, sending per-step cursors so the backend returns only new log lines (live-tail shaped).
- **Runs list refresh**: `GET {RefreshLink}` (same URL + `run_ids=<current page's run ids>`) → the `runs_list` fragment only.
- **Job queue refresh**: `GET {JobQueueRefreshLink}` (`?refresh=1&…`) → the `job_queue_list` fragment only.
- **Logs download**: `GET /runs/{run}/jobs/{job}/logs` → zip.
- Refresh intervals: `shared_actions.RefreshIntervalMs` — prod 3 s with activity / 12 s idle (dev 1 s / 2 s) (`shared/actions/job_queue.go:36–42`).

## 3. Data contracts (template/JSON shape → M1a's table census)

### 3.1 Runs list page (`actions.List` → `list.tmpl`, `actionRunListData` at actions.go:495–510)

ctx.Data: `ActionRunListData{RefreshLink, RefreshIntervalMs, ActionRuns []*ActionRun, IsFiltered, WorkflowNames map[workflowID]displayName, RunErrors map[runID]string, CurWorkflow, CanWriteRepoUnitActions}`; page-level: `workflows []WorkflowInfo{EntryName, ErrMsg, Workflow}` (default-branch `.gitea/workflows` files, parsed + validated: job-without-needs, resolvable `uses:`), `ScopedWorkflowGroups`, `OtherWorkflows` (runs whose workflow file is gone), `CurWorkflow/Disabled/IsListed/Required`, `HasWorkflowsOrRuns`, `Actors`, `RunBranches`, `StatusInfoList`, `CurActor/CurStatus/CurBranch/CurWorkflowRepoID`, `Page`, `WorkflowBadge`, `Branches/Tags/WorkflowDispatchInputs` (when the selected workflow has `workflow_dispatch`).

Table reads (SPEC-0012 §4.1 names): `action_runs` (filtered by workflow/scope/actor/status/ref + page) with `LoadTriggerUser`; `action_run_attempts` + `action_run_jobs` (`GetLatestAttemptJobsByRuns`) for the run-error pass — a waiting job's `WorkflowPayload` is re-validated and its `RunsOn` labels matched against online `action_runners`; git (default-branch commit, workflow entries, branches, tags). Query params: `workflow`, `scoped_workflow_source_repo_id`, `actor`, `status`, `branch`, `page`, `limit`, `run_ids`.

### 3.2 Run viewer (`ViewPost` → `ViewResponse`, view.go:291–417) — THE M1c JSON contract

```
artifacts: [{name, size, status, expiresUnix, previewLink?}]
state.run: {repoId, link, viewLink (attempt-aware), index, title, titleHTML,
            status, canCancel, canApprove, canRerun, canRerunFailed,
            canDeleteArtifact, done, workflowID, workflowLink,
            canViewWorkflowFile, isSchedule, runAttempt,
            attempts: [{attempt, status, done, link, current, latest, triggeredAt,
                        triggerUserName, triggerUserLink, triggerUserAvatar}],
            jobs: [{id, link, jobId?, name, status, canRerun, duration, needs?,
                    parentJobID, isReusableCaller, callUses?}],
            commit: {shortSHA, link, pusher:{displayName, link, avatarLink?},
                     branch:{name, link, isDeleted}},
            pullRequest?: {index, link},
            duration, triggeredAt, triggerEvent,
            jobSummaries?: [{jobId, jobName, summaryHTML}]}
state.currentJob: {title, detail, steps: [{summary, duration, status}]}
logs.stepsLog: [{step, cursor, lines: [{index, message, timestamp}]}]
```

Table reads: `action_runs` (+`LoadAttributes`), `action_run_attempts` (legacy runs: `LatestAttemptID == 0` → attempt-less path), `action_run_jobs` (ordered; matrix-deferred and reusable-caller derivations), `action_run_job_summaries` (per-step markdown → `summaryHTML`), `action_artifacts` (scoped by attempt: legacy rows `run_attempt_id=0`), git commit/branch, PR payload for fork-PR runs. **The `currentJob.steps` + `logs` arm needs `action_tasks` + `action_task_steps`** (`FullSteps`, `step.LogIndex/LogLength` slicing via `task.LogIndexes`) and `actions.ReadLogs` — that is M1b's log store (our `action_log_chunks` + R2 seal, SPEC-0012 §4.3); with no task (`EffectiveTaskID() == 0`, e.g. waiting job) steps/logs are empty arrays. Permission booleans (`canCancel/canApprove/canRerun/…`) derive from unit write permission + attempt recency + status.

SSR side of the same page (`View`): `Title` (job - run - workflow), `JobID` (0 = summary view), `ActionsViewURL` (run link, `…/attempts/{n}` or `…/jobs/{n}`).

### 3.3 Job queue (`shared_actions.RenderJobQueue`, `job_queue_list.tmpl`)

ctx.Data: `JobQueueJobs` (`FindJobQueueJobs` — running/waiting `action_run_jobs` joined with run + repo), `JobQueueRunners` (online `action_runners`), `JobQueueTotal`, `JobQueueFilterOwnerID/RepoID/Owners/Repos/Status/Statuses` (owner+repo filters only on the instance scope), `ShowRepoColumn`, `JobQueueRefreshLink` (`?refresh=1&owner_id&repo_id&status`), `JobQueueRefreshIntervalMs`, `Page`. Repo scope: `repoID` pinned, no owner/repo filters, sidebar from `prepareActionsSidebar`.

### 3.4 Runners settings (`shared_actions.Runners` / `RunnersEdit`)

List: `Runners []*ActionRunner` (filter `?q=`, sort, paginate), `Total`, `RegistrationToken` (from `action_runner_tokens`, with reset POST), `RunnerOwnerID/RunnerRepoID`, `SortType`, `AllowBulkActions` (admin only), `Page`. Edit: `Runner` + `Tasks []ActionTask` (recent tasks with job/run loaded, `action_tasks`). Everything else (create/delete/edit labels) posts back; bulk actions (admin): online/offline/delete.

### 3.5 Variables / secrets

Variables: `Variables []*ActionVariable` (`BelongingScope` = repo / owner / user / global per scope), `DataMaxLength`, `DescriptionMaxLength`; CRUD posts; table `action_variables` (already in our D1 per SPEC-0012 §4.1). Secrets: `shared/secrets/add_list.tmpl` fed by `repo_setting.Secrets` family over `models/secret.Secret` (our `secrets` table exists; org + user scopes already landed in our JSX tree — repo scope pending).

### 3.6 General settings (owner + repo)

Owner scope (`shared_actions.GeneralSettings`): `TokenPermissionMode` (+ Permissive/Restricted enums), `MaxTokenPermissions`, `EnableMaxTokenPermissions`, `AllowedRepos` (cross-repo allowlist), `OwnerID` — stored as `OwnerActionsConfig` JSON in **user settings** (`models/actions/config.go:39–55`, key `SettingsKeyActionsConfig`), rendered via `owner_general_settings` + `permission_mode_select` + `permissions_table`. Repo scope (`repo_setting.ActionsGeneralSettings`): unit enable/disable form (writes `repo_unit` config), owner-override checkbox, collaborative-owner add/delete, `token_permissions` POST (repo `ActionsConfig` in repo_unit config). No new actions tables — existing settings/repo-unit infrastructure.

### 3.7 Scoped workflows settings (`shared_actions.ScopedWorkflows`)

`ScopedWorkflowSources` views (per source repo: parsed entries + required flags), `RepoSearchUID`, `ScopedWorkflowsSearchExclusive/FullName`, `RedirectLink`, `ScopedWorkflowDirs`; table `action_scoped_workflow_source`. **SPEC-0012 defers scoped workflows beyond M3** — this page family should stay unlanded (dead-link rule) until that attachment.

### 3.8 Artifact preview + badge

Preview page ctx: `ArtifactPreviewData{RunURL, RunIndex, RunAttempt, ArtifactName, DownloadURL, PreviewContentURL, RequestedPathMissing, PreviewTooLarge, PreviewFilesTruncated, PreviewFiles[{Path, Name, Link, Depth, Selected}]}`; zip listing LRU-cached 10 min keyed (artifactID, updatedUnix); v4 = single-file zips, legacy = multi-row names. Badge: `GetWorkflowLatestRun` → status color map → flat / flat-square svg templates.

## 4. Phasing proposal — dispatchable M1c units

All units: Hono JSX pages under `apps/worker/src/ui/pages/` + read/write helpers beside them; `ui/index.ts` route arms and any `ui/links.ts` / `ui/locale.ts` additions are **orchestrator-integrated** (shared files); tests follow the landed `*.matrix.test.tsx` / goldens convention. Dependency key: **M1a** = runs/jobs/attempts/summaries/runners/variables reads + dispatch-side state; **M1b** = tasks/task-steps + log chunks + artifacts ingestion.

| Unit | Size | Content | Depends | Suggested file ownership (exclusive) |
|---|---|---|---|---|
| C1 runs list | **M** | `GET /:owner/:repo/actions` full page + `?run_ids=` partial-refresh fragment; sidebar, filters, no-workflows state; badge.svg + badge modal | M1a only | `ui/pages/repo-actions-list.tsx` (+ data helper + tests); POST `/disable` `/enable` (repo ActionsConfig writes) |
| C2 run viewer summary | **L** | `view` SSR shell (mount div + locale attrs); `POST ViewResponse` summary arm: run/attempts/jobs/commit/PR/jobSummaries/artifacts + `state.currentJob` shell | M1a only (summaries are M1b-written but M1a-read-safe as empty) | `ui/pages/repo-actions-run-view.tsx`, `ui/pages/actions-view-response.ts` (+ tests incl. a `MockActionsRunsJobs`-derived golden) |
| C3 log tail + steps | **M** | `currentJob.steps` arm (task steps) + `logs.stepsLog` cursors arm + `GET /runs/{run}/jobs/{job}/logs` zip | **M1b** | `actions-view-response.ts` log arm + `ui/pages/actions-logs.ts` |
| C4 artifacts UI | **M** | artifact download (v4 raw / legacy zip compose), delete, preview page + root `/-/actions/artifacts/…` signed raw route | **M1b** (R2 artifact layout) | `ui/pages/repo-actions-artifacts.ts` (+ preview page + tests) |
| C5 run mutations | **S–M** | cancel / approve / delete / approve-all-checks POSTs (JSON); rerun + rerun-failed **flagged**: needs attempt creation + job re-emission — confirm M1b's emitter covers it or defer to M3 | M1a/M1b; rerun maybe M3 | same files as C2 (fold into C2's owner) |
| C6 job queue | **S** | repo `/actions/job_queue` + admin `/admin/actions/job_queue` + shared fragment + refresh morph | M1a | `ui/pages/actions-job-queue.tsx` (+ tests) |
| C7 runners settings | **S** | runners list/edit/delete/bulk + registration token (4 scopes; `PageType` switchyard → per-scope routes reusing one component family) | M1a | `ui/pages/*-settings-actions-runners.tsx` (+ tests) |
| C8 repo secrets + variables | **S** | repo-scope secrets + variables arms (org/user twins landed at waves 58/59) | existing tables | `ui/pages/repo-settings-actions-secrets-variables.tsx` |
| C9 general settings | **M** | owner token-permission general page (org/user/admin), repo unit-toggle + collaborative owners + token_permissions; actions entries in the settings navbars | existing infra (user settings JSON + repo_unit) | `ui/pages/*-settings-actions-general.tsx` (+ tests) |
| C10 scoped-workflows pages | defer | rides the scoped-workflows SPEC-attachment (post-M3) — keep 404 per dead-link rule | deferred | — |

Dispatch order that maximizes parallelism: C1 + C6 + C7 can go the moment M1a lands (three independent units); C2 follows M1a (needs the run-view JSON frozen against the devtest mock); C3 + C4 follow M1b; C8/C9 anytime (no actions tables at all). The partial-refresh morph endpoints (C1/C6) and the `ViewResponse` JSON (C2) are the two byte-shape contracts that deserve goldens on day one.

## 5. Open questions for the orchestrator / M1c SPEC

1. **Rerun ownership**: rerun creates a new `ActionRunAttempt` and re-emits job rows — does M1b's harness emitter expose that, or does rerun wait for M3's job emitter? (Upstream: `Rerun` → `actions_service.RerunRerunJobs`… emitter territory.) C5's size hinges on this.
2. **Manifest chunk**: confirm our assets manifest actually exposes the Vue actions chunk (the official bundle ships it; SPEC-0008 §2.3's manifest reader must include it for `#repo-action-view` to mount).
3. **`titleHTML` parity**: `ViewResponse.state.run.titleHTML` is server-rendered commit-message HTML — reuse the landed markup render pipeline (SPEC-0008 §3.4) rather than re-porting `RenderCommitMessage`.
4. **Dispatch (POST /run) depth**: parsing workflow YAML + `InsertRun` is M3's producer arm; C1 can SSR the button grayed/absent until M3, or defer the form — decide at C1 review.
5. **Session/CSRF posture for the JSON POSTs**: `ViewPost` is a same-origin fetch with a JSON body; landed pages use `sameOriginGuard` for form posts — extend the same guard, document in the M1c SPEC.
6. **Refresh-interval parity**: port `RefreshIntervalMs` (3 s/12 s prod) verbatim; `setting.IsProd` has no direct analog — pick our posture.
7. **Admin scope gates**: `RunnerBulkActionPost` and the admin job queue need the site-admin gate — follow `admin-users` posture.
8. **Partial-refresh URL fidelity**: upstream's `RefreshLink` is `AppSubURL + RequestURI + ?run_ids=…` (keeps filters); mirror exactly so filter state survives morphs.

## 6. Confidence

- **High**: route census, template inventory, data-contract shapes, JS-vs-SSR split — all read directly from the pinned source this session; the landed JSX waves confirm the serving posture.
- **Medium-high**: phasing sizes and dependency edges — M1a/M1b are still in flight, so exact service seams (especially rerun/emitter, log-read API shape) may shift; the census pins the *targets*, not M1a's final APIs.
- The `ViewResponse` struct is the single most load-bearing artifact for C2/C3; it is stable at this pin and upstream's devtest mock (`mock_actions.go`) is a ready-made fixture source.

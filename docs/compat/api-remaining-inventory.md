# Remaining API Inventory — the last 86 before the feature wall

Refill ammunition for the wave pool: every operation the frozen contract
declares that our `/api/v1` spec does not, classified by what it would take to
declare it, then ranked into dispatchable batches. Companion to
`ui-parity-survey.md` (the web-UI gap inventory) — this file is the API-side
equivalent. **Fully regenerated 2026-10-26** at HEAD `fec5c71` after the
previous edition (written at declared=318, commit `c4577a7`) drove ~129
declarations to completion — every batch it listed has landed or is in flight.

- **Sources / method**: frozen contract
  `apps/worker/src/compat/contract/v1-swagger.generated.json` (**554**
  operations across 350 paths: repository 229, user 98, organization 88,
  issue 72, admin 33, miscellaneous 14, package 9, notification 7, settings 4)
  minus the declared set that `node scripts/check-openapi.mjs` reports
  (**447** operations across **275** paths, measured 2026-10-26 at HEAD
  `fec5c71`; checker ends `PASS`, tier-1 coverage 78/78 paths, 129/129
  operations). Raw diff: **107 undeclared**; minus the **21 in-flight**
  org-project ops (see In-flight below) = **86 remaining**.
  Issue / notification / miscellaneous / settings families have **zero**
  remaining — they are fully declared.
- **Reproducing the diff** (the numbers above fall out of exactly these two
  commands, run from the repo root):
  1. `node scripts/check-openapi.mjs` — prints `declared: 447 operation(s)
     across 275 path(s)` and every declared op as `[ok] <METHOD> <path>
     (<operationId>)`. The checker hard-fails any declared op missing from the
     contract, so declared ⊆ contract and the diff is a plain set subtraction
     on `METHOD path` (it is unambiguous: all 447 shared ops carry the
     contract's own operationId).
  2. `node -e` walking `paths` of the contract JSON with the checker's HTTP
     method set (`get put post delete options head patch`), printing
     `<tag> | <METHOD> <path> | <operationId>` per op (554 rows); subtract the
     checker's 447.
- **Upstream pin**: `fc4936884584a41931906553d96c2601d750e6ef`
  (v1.22.0-rc1-3919-gfc49368845); every `gitea/…` cite below is that commit.
- **Landed-store references**: `apps/worker/src/db/schema.ts` (**64 tables**,
  migrations 0000–0028), route modules under `apps/worker/src/api/routes/`,
  services under `apps/worker/src/{services,api/services,repos,issues,webhooks}/`.

## Classification legend

- **IMPLEMENTABLE-NOW** — table-free, or rides an already-migrated store. The
  batch only writes route/service code (plus spec declaration).
- **TABLE-DEPENDENT** — needs new D1 table(s) (or a column). The missing store
  is named with its upstream model pointer; the batch owns one migration
  (numbers below are **provisional** — migrations run 0000–0028 today, next
  free is 0029; assign next-free at merge, drizzle journal regenerated then).
- **RUNTIME-ONLY** — declarable only with documented runtime-only response
  exceptions (the `RUNTIME_ONLY_RESPONSES` table in `scripts/check-openapi.mjs`,
  shared file — orchestrator applies or designates), typically because the
  upstream behavior is degenerate on Workers (no filesystem, no signing key).
- **FEATURE-ABSENT** — gated on a whole feature (actions runtime, package
  registry) that needs its own SPEC; listed with the pointer, not batched.

## Family summary (remaining — in-flight excluded)

| Class | repository | organization | user | admin | package | **total** |
|---|---|---|---|---|---|---|
| IMPLEMENTABLE-NOW | 0 | 0 | 22 | 0 | 0 | **22** |
| TABLE-DEPENDENT | 0 | 0 | 0 | 0 | 0 | **0** |
| RUNTIME-ONLY | 0 | 0 | 0 | 0 | 0 | **0** |
| FEATURE-ABSENT | 33 | 7 | 7 | 8 | 9 | **64** |
| **total** | **33** | **7** | **29** | **8** | **9** | **86** |

(Including the in-flight 21, the raw 107 organize as: repository 33,
organization 28, user 29, admin 8, package 9.)

The pool is nearly drained: **one** ready batch remains (projects stage 3,
user scope). Everything after it is FEATURE-ABSENT — declaring the full
surface short of actions/packages would put the ceiling at 490/554 ops.

---

## In-flight (excluded from "remaining" — do not re-dispatch)

### projects-org stage 2 — 21 org project ops (uncommitted)

`apps/worker/src/api/routes/projects-org.ts` (+ `projects-org.test.ts`) sits
uncommitted in the tree: **21 route declarations** over the 11
`/orgs/{org}/projects…` paths (4 DELETE, 7 GET, 3 PATCH, 7 POST — matches the
contract's org-projects set exactly), riding the landed projects store
(migration 0024) and `src/api/services/projects.ts` (`ProjectScope`, kind
`"organization"`). Op ids are the `org*Project*` family: `orgListProjects`,
`orgGetProject`, `orgCreateProject`, `orgEditProject`, `orgDeleteProject`,
`orgListProjectColumns`, `orgGetProjectColumn`, `orgCreateProjectColumn`,
`orgEditProjectColumn`, `orgDeleteProjectColumn`, `orgSetDefaultProjectColumn`,
`orgMoveProjectColumns`, `orgListProjectColumnIssues`,
`orgAddIssueToProjectColumn`, `orgRemoveIssueFromProjectColumn`,
`orgMoveProjectIssue`, `orgListProjectWorkflows`, `orgGetProjectWorkflow`,
`orgCreateProjectWorkflow`, `orgEditProjectWorkflow`, `orgDeleteProjectWorkflow`.

### Other in-flight units — zero new ops

- **blocks-enforcement tail** — arms `ErrBlockedUser` 403 on existing routes
  (`identity.ts`, `issue-t2.ts`, `org-teams.ts`, `repo.ts`, `starred.ts`,
  `subscription.ts` modified in the tree); the 8 block ops themselves landed
  (`1934664`).
- **license-detection** — populates the landed `repo_licenses` table behind the
  already-declared `GET /repos/{owner}/{repo}/licenses`; no new op.
- **ui waves** — web-UI surface, not `/api/v1`; tracked in
  `ui-parity-survey.md`.

---

## Landed since last regen

The previous edition (commit `c4577a7`, declared=318) listed 11 numbered
batches + 4 long-tail candidates. **All 15 landed.** REG deltas below are the
committed `declared X→Y` jumps (they sum: 318 + 129 = 447):

| # | Batch | Ops | Store / migration | Feature commit(s) | REG commit (declared) |
|---|---|---|---|---|---|
| 1 | `wave-api-hooks-scopes` (15) + `wave-api-admin-degenerate` (5) + the free `repoMirrorSync` declaration (1) | 21 | table-free; RUNTIME_ONLY gate entries ×9 | `5b704c5`-era modules (hooks-scopes, admin-degenerate) | `4e90180` (318→339) |
| 2 | `wave-api-avatars` | 6 | R2 avatar store, table-free | `d7f5646` | `8afcfdd` (339→345) |
| 3 | `wave-api-tokens-times-aggregates` + `admin-org-extras` (batch 1's remaining 12; `repoMirrorSync` went with #1) | 12 | table-free | `bfccc02` | `76e8ca4` (345→357) |
| 4 | `wave-api-deploy-keys` | 5 | `deploy_keys` (0020) | `4af12a9` | `a01c464` (357→362) |
| 5 | `wave-api-secrets-variables` | 23 | `secrets` + `action_variables` (0021) | `a5506d2` | `9f92950` (362→385) |
| 6 | `wave-api-blocks` (8, 0022) + `wave-api-push-mirrors` (5, 0023) + `wave-api-tag-protections` (5, 0025) + `wave-api-wiki` (6, table-free) | 24 | see left | `1934664` / `8f0aa90` / `a80878c` / `d3362b1` | `51d3c74` (385→409) |
| 7 | `wave-api-git-hooks` | 4 | table-free (R2-persisted edits) | `5b704c5` | `12ab90d` (409→413) |
| 8 | `wave-api-projects-repo` **stage 1** (repo scope) | 21 | `projects`/`project_columns`/`project_issues`/`project_workflows` (0024) | `0d5b480` | `fc123b0` (413→434) |
| 9 | `wave-api-oauth2-apps` (5, 0026) + `wave-api-badges-licenses-template` (5, 0027) + `wave-api-feeds` (3, 0028) | 13 | see left | `42ab6a5` / `f328d06` / `2ef9359` | `fec5c71` (434→447) |

Non-op landings in the same window: `wave-22 tables` (`640d805`), `wave-23
tables` (`579e872`), `wave-blocks-enforcement` (`f5c0384` — 403 arms on 9
existing seams), engine-registry lifecycle fixes (`4f574e9`, `1da8f56`,
`5e2c418`), ui waves (`06eee50`), vitest timeout raise (`412facc`).

---

## Dispatchable batches

### Batch — `wave-api-projects-user` stage 3 (22 ops, NO migration — the last ready batch)

The only dispatchable work left. Rides the stage-1 store verbatim:
`projects` / `project_columns` / `project_issues` / `project_workflows`
(schema.ts:2162/2213/2254/2286, migration 0024 — the table is owner-scoped
with `owner_id` + `repo_id` + `type`, covering all three scopes) and the
`ProjectScope` abstraction in `src/api/services/projects.ts` (kind
`"individual"` is already modeled; `repoProjectScope()` shows the seam). Wire
logic mirrors the landed repo scope (`routes/projects-repo.ts`) and the
in-flight org scope (`routes/projects-org.ts`). Upstream pointers: the shared
scope router `gitea/routers/api/v1/shared/project.go` and the mount groups
`gitea/routers/api/v1/api.go:1102` (repo), `:1689` (org), `:1755`
(user `/user/projects`).

- 21 ops mirror the org scope 1:1 under `/user/projects…` with
  `userCurrent*` op ids (create/get/list/edit/delete project, columns CRUD +
  default/move, column-issue add/remove/list/move, workflows CRUD).
- Plus the one extra op the user scope carries:
  `GET /users/{username}/projects` (`userListProjects`) — visible-profile
  listing on the `/users/{username}` group, distinct from the self-scoped
  `/user/projects`.

**Files to own**: new `src/api/routes/projects-user.ts` (+ test) — the file
does not exist yet (verified); REG entry in `src/api/router.ts` (shared,
orchestrator/designee). **No schema change, no migration.**

### After this batch — nothing dispatchable without a feature SPEC

Declaring the remaining 64 ops requires the feature, not just a route stub:

- **Actions runtime, 54 ops** (repository 33, organization 7, user 7, admin 7):
  runners, runs, jobs, artifacts, tasks, workflow dispatch/enable,
  registration tokens — upstream `gitea/models/actions/` (`runner.go`,
  `run.go`, `run_job.go`, `run_attempt.go`, `artifact.go`,
  `runner_token.go`, …) + `gitea/services/actions/`. **No CI-runtime table
  exists in our schema** (grep of `apps/worker/src/db/schema.ts` for
  `action_run`/`action_runner`/`action_artifact`/`action_task`/runner-token
  tables: zero hits — the only `action` table there is the activity feed,
  schema.ts:2530). A full SPEC is the precondition; note some list/read ops
  (e.g. `ActionsListRepositoryWorkflows`) read `.gitea/workflows` from the git
  tree upstream and could ride engine tree reads — still gate them on the same
  SPEC so the family lands coherently.
- **Package registry, 10 ops** (9 `/packages/*` + `GET /admin/packages`):
  upstream `gitea/models/packages/`, `gitea/modules/packages/` — storage-heavy
  (R2 candidate store per AGENTS; evaluate in a SPEC before adopting). **No
  package table exists** in our schema (only the `repositories.has_packages`
  flag column).

---

### repository — FEATURE-ABSENT (33)

All actions-runtime. Missing store: the upstream actions tables named above —
none exist in `apps/worker/src/db/schema.ts` (verified by grep).

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteArtifact` | `DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}` | actions runtime — absent upstream models/actions/ tables (action_run/action_run_job/action_artifact/…; verified absent in schema.ts) + gitea/services/actions/; SPEC first |
| `deleteRepoRunner` | `DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}` | actions runtime — same absent store (gitea/models/actions/runner.go) |
| `deleteActionRun` | `DELETE /repos/{owner}/{repo}/actions/runs/{run}` | actions runtime — same absent store (gitea/models/actions/run.go) |
| `getArtifacts` | `GET /repos/{owner}/{repo}/actions/artifacts` | actions runtime — same absent store (artifact.go) |
| `getArtifact` | `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}` | actions runtime — same absent store (artifact.go) |
| `downloadArtifact` | `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` | actions runtime — same absent store; artifact blobs are R2 territory per the storage-service boundary |
| `listWorkflowJobs` | `GET /repos/{owner}/{repo}/actions/jobs` | actions runtime — same absent store (run_job.go) |
| `getWorkflowJob` | `GET /repos/{owner}/{repo}/actions/jobs/{job_id}` | actions runtime — same absent store (run_job.go) |
| `downloadActionsRunJobLogs` | `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` | actions runtime — same absent store; logs land in R2 when specced |
| `getRepoRunners` | `GET /repos/{owner}/{repo}/actions/runners` | actions runtime — same absent store (runner.go) |
| `getRepoRunner` | `GET /repos/{owner}/{repo}/actions/runners/{runner_id}` | actions runtime — same absent store (runner.go) |
| `getWorkflowRuns` | `GET /repos/{owner}/{repo}/actions/runs` | actions runtime — same absent store (run.go) |
| `GetWorkflowRun` | `GET /repos/{owner}/{repo}/actions/runs/{run}` | actions runtime — same absent store (run.go) |
| `getArtifactsOfRun` | `GET /repos/{owner}/{repo}/actions/runs/{run}/artifacts` | actions runtime — same absent store |
| `getWorkflowRunAttempt` | `GET /repos/{owner}/{repo}/actions/runs/{run}/attempts/{attempt}` | actions runtime — same absent store (run_attempt.go) |
| `listWorkflowRunAttemptJobs` | `GET /repos/{owner}/{repo}/actions/runs/{run}/attempts/{attempt}/jobs` | actions runtime — same absent store (run_attempt.go) |
| `listWorkflowRunJobs` | `GET /repos/{owner}/{repo}/actions/runs/{run}/jobs` | actions runtime — same absent store (run_job.go) |
| `getWorkflowRunLogs` | `GET /repos/{owner}/{repo}/actions/runs/{run}/logs` | actions runtime — same absent store |
| `ListActionTasks` | `GET /repos/{owner}/{repo}/actions/tasks` | actions runtime — same absent store |
| `ActionsListRepositoryWorkflows` | `GET /repos/{owner}/{repo}/actions/workflows` | actions runtime — reads .gitea/workflows from the git tree upstream; could ride engine tree reads, gated on the same SPEC |
| `ActionsGetWorkflow` | `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}` | actions runtime — same family gate |
| `ActionsListWorkflowRuns` | `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs` | actions runtime — same absent store |
| `updateRepoRunner` | `PATCH /repos/{owner}/{repo}/actions/runners/{runner_id}` | actions runtime — same absent store (runner.go) |
| `repoCreateRunnerRegistrationToken` | `POST /repos/{owner}/{repo}/actions/runners/registration-token` | actions runner tokens (gitea/models/actions/runner_token.go — absent) |
| `approveWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/approve` | actions runtime (gitea/services/actions/approve.go — absent store) |
| `cancelWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/cancel` | actions runtime — same absent store |
| `forceCancelWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/force-cancel` | actions runtime — same absent store |
| `rerunWorkflowJob` | `POST /repos/{owner}/{repo}/actions/runs/{run}/jobs/{job_id}/rerun` | actions runtime — same absent store |
| `rerunWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/rerun` | actions runtime — same absent store |
| `rerunFailedWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/rerun-failed-jobs` | actions runtime — same absent store |
| `ActionsDispatchWorkflow` | `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` | actions runtime — dispatch creates runs in the absent store |
| `ActionsDisableWorkflow` | `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable` | actions runtime — same family gate |
| `ActionsEnableWorkflow` | `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable` | actions runtime — same family gate |

### organization — FEATURE-ABSENT (7)

All actions-runtime, same absent store.

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteOrgRunner` | `DELETE /orgs/{org}/actions/runners/{runner_id}` | actions runtime — absent gitea/models/actions/ runner store (verified absent in schema.ts) |
| `getOrgWorkflowJobs` | `GET /orgs/{org}/actions/jobs` | actions runtime — same absent store |
| `getOrgRunners` | `GET /orgs/{org}/actions/runners` | actions runtime — same absent store |
| `getOrgRunner` | `GET /orgs/{org}/actions/runners/{runner_id}` | actions runtime — same absent store |
| `getOrgWorkflowRuns` | `GET /orgs/{org}/actions/runs` | actions runtime — same absent store |
| `updateOrgRunner` | `PATCH /orgs/{org}/actions/runners/{runner_id}` | actions runtime — same absent store |
| `orgCreateRunnerRegistrationToken` | `POST /orgs/{org}/actions/runners/registration-token` | actions runner tokens (gitea/models/actions/runner_token.go — absent) |

(The org-projects 21 are **in-flight**, not here — see the In-flight section.)

### user

**IMPLEMENTABLE-NOW** (22) — the stage-3 batch above, itemized. Rides the
landed projects store (migration 0024) + `ProjectScope` kind `"individual"`;
template: `routes/projects-repo.ts` (landed) / `routes/projects-org.ts`
(in-flight).

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `userCurrentDeleteProject` | `DELETE /user/projects/{id}` | LANDED projects store (schema.ts:2162, migration 0024) + services/projects.ts ProjectScope kind "individual" — mirror routes/projects-repo.ts (landed) and in-flight projects-org.ts |
| `userCurrentDeleteProjectColumn` | `DELETE /user/projects/{id}/columns/{column_id}` | same landed store (project_columns schema.ts:2213) — stage-3 batch |
| `userCurrentRemoveIssueFromProjectColumn` | `DELETE /user/projects/{id}/columns/{column_id}/issues/{issue_id}` | same landed store (project_issues schema.ts:2254), issue moves ride landed issues — stage-3 batch |
| `userCurrentDeleteProjectWorkflow` | `DELETE /user/projects/{id}/workflows/{workflow_id}` | same landed store (project_workflows schema.ts:2286) — stage-3 batch |
| `userCurrentListProjects` | `GET /user/projects` | same landed store — stage-3 batch |
| `userCurrentGetProject` | `GET /user/projects/{id}` | same landed store — stage-3 batch |
| `userCurrentListProjectColumns` | `GET /user/projects/{id}/columns` | same landed store — stage-3 batch |
| `userCurrentGetProjectColumn` | `GET /user/projects/{id}/columns/{column_id}` | same landed store — stage-3 batch |
| `userCurrentListProjectColumnIssues` | `GET /user/projects/{id}/columns/{column_id}/issues` | same landed store — stage-3 batch |
| `userCurrentListProjectWorkflows` | `GET /user/projects/{id}/workflows` | same landed store — stage-3 batch |
| `userCurrentGetProjectWorkflow` | `GET /user/projects/{id}/workflows/{workflow_id}` | same landed store — stage-3 batch |
| `userListProjects` | `GET /users/{username}/projects` | the user scope's extra op — visible listing on the /users/{username} group, same landed store + profile-visibility gates — stage-3 batch |
| `userCurrentEditProject` | `PATCH /user/projects/{id}` | same landed store — stage-3 batch |
| `userCurrentEditProjectColumn` | `PATCH /user/projects/{id}/columns/{column_id}` | same landed store — stage-3 batch |
| `userCurrentEditProjectWorkflow` | `PATCH /user/projects/{id}/workflows/{workflow_id}` | same landed store — stage-3 batch |
| `userCurrentCreateProject` | `POST /user/projects` | same landed store — stage-3 batch |
| `userCurrentCreateProjectColumn` | `POST /user/projects/{id}/columns` | same landed store — stage-3 batch |
| `userCurrentMoveProjectColumns` | `POST /user/projects/{id}/columns/move` | same landed store — stage-3 batch |
| `userCurrentSetDefaultProjectColumn` | `POST /user/projects/{id}/columns/{column_id}/default` | same landed store — stage-3 batch |
| `userCurrentAddIssueToProjectColumn` | `POST /user/projects/{id}/columns/{column_id}/issues/{issue_id}` | same landed store — stage-3 batch |
| `userCurrentMoveProjectIssue` | `POST /user/projects/{id}/issues/{issue_id}/move` | same landed store — stage-3 batch |
| `userCurrentCreateProjectWorkflow` | `POST /user/projects/{id}/workflows` | same landed store — stage-3 batch |

**FEATURE-ABSENT** (7) — actions-runtime, same absent store.

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteUserRunner` | `DELETE /user/actions/runners/{runner_id}` | actions runtime — absent gitea/models/actions/ runner store (verified absent in schema.ts) |
| `getUserWorkflowJobs` | `GET /user/actions/jobs` | actions runtime — same absent store |
| `getUserRunners` | `GET /user/actions/runners` | actions runtime — same absent store |
| `getUserRunner` | `GET /user/actions/runners/{runner_id}` | actions runtime — same absent store |
| `getUserWorkflowRuns` | `GET /user/actions/runs` | actions runtime — same absent store |
| `updateUserRunner` | `PATCH /user/actions/runners/{runner_id}` | actions runtime — same absent store |
| `userCreateRunnerRegistrationToken` | `POST /user/actions/runners/registration-token` | actions runner tokens (gitea/models/actions/runner_token.go — absent) |

### admin — FEATURE-ABSENT (8)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteAdminRunner` | `DELETE /admin/actions/runners/{runner_id}` | actions runtime — absent gitea/models/actions/ runner store (verified absent in schema.ts) |
| `listAdminWorkflowJobs` | `GET /admin/actions/jobs` | actions runtime — same absent store |
| `getAdminRunners` | `GET /admin/actions/runners` | actions runtime — same absent store |
| `getAdminRunner` | `GET /admin/actions/runners/{runner_id}` | actions runtime — same absent store |
| `listAdminWorkflowRuns` | `GET /admin/actions/runs` | actions runtime — same absent store |
| `adminListPackages` | `GET /admin/packages` | package registry (upstream gitea/models/packages/, gitea/modules/packages/) — no package table in schema.ts (only repositories.has_packages); needs SPEC before adoption (R2 candidate store) |
| `updateAdminRunner` | `PATCH /admin/actions/runners/{runner_id}` | actions runtime — same absent store |
| `adminCreateRunnerRegistrationToken` | `POST /admin/actions/runners/registration-token` | actions runtime — same absent store |

### package — FEATURE-ABSENT (9)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deletePackage` | `DELETE /packages/{owner}/{type}/{name}` | package registry (upstream gitea/models/packages/, gitea/modules/packages/) — no package table in schema.ts (only repositories.has_packages); needs SPEC before adoption (R2 candidate store) |
| `deletePackageVersion` | `DELETE /packages/{owner}/{type}/{name}/{version}` | package registry — same absent store, same SPEC gate |
| `listPackages` | `GET /packages/{owner}` | package registry — same absent store, same SPEC gate |
| `listPackageVersions` | `GET /packages/{owner}/{type}/{name}` | package registry — same absent store, same SPEC gate |
| `getLatestPackageVersion` | `GET /packages/{owner}/{type}/{name}/-/latest` | package registry — same absent store, same SPEC gate |
| `getPackage` | `GET /packages/{owner}/{type}/{name}/{version}` | package registry — same absent store, same SPEC gate |
| `listPackageFiles` | `GET /packages/{owner}/{type}/{name}/{version}/files` | package registry — same absent store, same SPEC gate |
| `linkPackage` | `POST /packages/{owner}/{type}/{name}/-/link/{repo_name}` | package registry — same absent store, same SPEC gate |
| `unlinkPackage` | `POST /packages/{owner}/{type}/{name}/-/unlink` | package registry — same absent store, same SPEC gate |

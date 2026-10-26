# Remaining API Inventory — the last 64: the feature wall itself

Refill ammunition for the wave pool: every operation the frozen contract
declares that our `/api/v1` spec does not, classified by what it would take to
declare it, then ranked into dispatchable batches. Companion to
`ui-parity-survey.md` (the web-UI gap inventory) — this file is the API-side
equivalent. **Fully regenerated 2026-10-26** at HEAD `fec5c71` after the
previous edition (written at declared=318, commit `c4577a7`) drove ~129
declarations to completion — every batch it listed has since landed (the
tick below closes the last two out).
**Ticked 2026-10-26** at HEAD `7016ce9`: a maintenance pass, not a regen —
the second today (the previous one, at `5d9122c`, closed out the regen's
last two batches: the org-projects stage 2, REG `20512c0`, 447→468, and
projects-user stage 3, REG `c9a7ef7`, 468→490). The `5d9122c..7016ce9`
window — 23 commits: two UI waves, the fork-PR / head-render / payload
pull arc, the annotated-tag carry, the merge-delete ladder completion,
the generate/fork git-wire fix, the ws1009 mitigation + sweep, a docs
run — carries **zero new operations**.
Declared still **490** across **298** paths; the raw diff is **64**, all
FEATURE-ABSENT (the 64-op tables below are unchanged from the regen); the
dispatchable pool is empty and the In-flight section is cleared. The
window's landings are appended to the post-490 ledger below.

- **Sources / method**: frozen contract
  `apps/worker/src/compat/contract/v1-swagger.generated.json` (**554**
  operations across 350 paths: repository 229, user 98, organization 88,
  issue 72, admin 33, miscellaneous 14, package 9, notification 7, settings 4)
  minus the declared set that `node scripts/check-openapi.mjs` reports
  (**490** operations across **298** paths, measured 2026-10-26 at HEAD
  `7016ce9`; checker ends `PASS`, tier-1 coverage 78/78 paths, 129/129
  operations). Raw diff: **64 undeclared** = **64 remaining**, all
  FEATURE-ABSENT — no in-flight subtraction applies any more.
  Issue / notification / miscellaneous / settings families have **zero**
  remaining — they are fully declared.
- **Reproducing the diff** (the numbers above fall out of exactly these two
  commands, run from the repo root):
  1. `node scripts/check-openapi.mjs` — prints `declared: 490 operation(s)
     across 298 path(s)` and every declared op as `[ok] <METHOD> <path>
     (<operationId>)`. The checker hard-fails any declared op missing from the
     contract, so declared ⊆ contract and the diff is a plain set subtraction
     on `METHOD path` (it is unambiguous: all 490 shared ops carry the
     contract's own operationId).
  2. `node -e` walking `paths` of the contract JSON with the checker's HTTP
     method set (`get put post delete options head patch`), printing
     `<tag> | <METHOD> <path> | <operationId>` per op (554 rows); subtract the
     checker's 490.
- **Upstream pin**: `fc4936884584a41931906553d96c2601d750e6ef`
  (v1.22.0-rc1-3919-gfc49368845); every `gitea/…` cite below is that commit.
- **Landed-store references**: `apps/worker/src/db/schema.ts` (**64 tables**,
  migrations 0000–0032), route modules under `apps/worker/src/api/routes/`,
  services under `apps/worker/src/{services,api/services,repos,issues,webhooks}/`.

## Classification legend

- **IMPLEMENTABLE-NOW** — table-free, or rides an already-migrated store. The
  batch only writes route/service code (plus spec declaration).
- **TABLE-DEPENDENT** — needs new D1 table(s) (or a column). The missing store
  is named with its upstream model pointer; the batch owns one migration
  (numbers below are **provisional** — migrations run 0000–0032 today;
  assign next-free at merge, drizzle journal regenerated then). The class is
  empty at this tick.
- **RUNTIME-ONLY** — declarable only with documented runtime-only response
  exceptions (the `RUNTIME_ONLY_RESPONSES` table in `scripts/check-openapi.mjs`,
  shared file — orchestrator applies or designates), typically because the
  upstream behavior is degenerate on Workers (no filesystem, no signing key).
- **FEATURE-ABSENT** — gated on a whole feature (actions runtime, package
  registry) that needs its own SPEC; listed with the pointer, not batched.

## Family summary (remaining)

| Class | repository | organization | user | admin | package | **total** |
|---|---|---|---|---|---|---|
| IMPLEMENTABLE-NOW | 0 | 0 | 0 | 0 | 0 | **0** |
| TABLE-DEPENDENT | 0 | 0 | 0 | 0 | 0 | **0** |
| RUNTIME-ONLY | 0 | 0 | 0 | 0 | 0 | **0** |
| FEATURE-ABSENT | 33 | 7 | 7 | 8 | 9 | **64** |
| **total** | **33** | **7** | **7** | **8** | **9** | **64** |

The pool is drained: declared **490/554** — exactly the ceiling short of the
actions/packages features. Every non-FEATURE-ABSENT class is at zero; the
64 below move only when an actions or package SPEC lands, never by route
work.

---

## In-flight

Empty at this tick. The regen's three in-flight pools all landed: the
org-projects 21 (REG `20512c0`), the blocks-enforcement tail (`f2e1710`)
and license-detection (`03d5fe4`/`04a2903` — the family is complete, 5/5
arms), and the ui-parity-3 rows (`ca81d5a`). The tree's modifications at
measurement time were this doc plus the in-flight `/{username}/-/projects`
wave's uncommitted files under `apps/worker/src/ui/` and a scratch script
— none of them spec-bearing as measured (the checker still reports
490/298 in exactly this tree state).

---

## Landed since last regen

The previous edition (commit `c4577a7`, declared=318) listed 11 numbered
batches + 4 long-tail candidates. **All 15 landed**, and both batches the
regen left live landed after it. REG deltas below are the committed
`declared X→Y` jumps (they sum: 318 + 172 = 490; rows 1–9 are the previous
edition's ledger, 10–11 landed after the `99d21c5` regen):

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
| 10 | `wave-api-projects-org` stage 2 (the regen's in-flight batch) | 21 | rides the stage-1 store (0024) — no migration | `cc6d73e` | `20512c0` (447→468) |
| 11 | `wave-api-projects-user` stage 3 (the regen's one dispatchable batch) | 22 | rides the stage-1 store (0024) — no migration | `f38b218` | `c9a7ef7` (468→490) |

Non-op landings in the same window: `wave-22 tables` (`640d805`), `wave-23
tables` (`579e872`), `wave-blocks-enforcement` (`f5c0384` — 403 arms on 9
existing seams), engine-registry lifecycle fixes (`4f574e9`, `1da8f56`,
`5e2c418`), ui waves (`06eee50`), vitest timeout raise (`412facc`).

### After the 490 line — post-regen landings (zero new ops)

Everything merged after REG `c9a7ef7` carries no new declarations — the
checker stays at 490/298 (re-run at this tick's HEAD `7016ce9`). The units,
grouped:

- **API parity**: blocks-enforcement-2 tail (`f2e1710` — the regen's
  in-flight arm set), license arms (`03d5fe4` + `04a2903` — the regen's
  in-flight license-detection), merge-delete guards (`faca961` +
  `66f5977`), starred-totals render (`207b566`), repo-delete action sweep
  (`389da18`), push-mirror outbound + orchestrator wiring (`b332e14` +
  `9bda9eb`), generate loose-carry (`6c54c1a`) + cleanup (`7f0d5a6`),
  first-push settle (`45631b7`), set-private-zero (`3163658`),
  star/watch counters (`528d369`), counters-2 (`3016c10`), delete-counters
  fold (`64e9b1b`), feeds-tail action rows (`64ade9f`), repo size
  (`3c58cce`), registry tombstone oracle (`e30660d`). The
  `5d9122c..7016ce9` window adds: merge-delete ladder completion
  (`2e3db28` — the fork-head after-merge delete; joins `faca961` +
  `66f5977` above), fork PR creation (`a16f60e` — cross-repo heads
  end-to-end: parseHead grammar + fork edge, anti-enumeration CanRead
  404s, merge-base computed in the head cell), PR head repo render
  (`0466356` — upstream's hidden-head gate, one visibility resolution
  feeding gate + perms), pull payload mode (`836f87a` — the
  ToPayloadPullRequest port: hidden forks render head.repo with
  AccessModeNone perms), annotated-tag carry (`ab5d300` — packed-aware
  partition; fixes both fork-generate and rename, which dropped even
  packed tags), archive ref convergence (`889b74a`), the payload sites
  tail (`7016ce9` — label-detach/assignee/review-submission/
  review-request emitters), and the generate/fork git-wire fix
  (`8828f43` — replicateRepoCopy brokers the §5.3 copy with UNCONDITIONAL
  loose carry; closes the generated-repo wire residual `bf8e56f`
  re-scoped OPEN).
- **Migrations 0029–0032** landed with them (`size_kb`, `num_stars`/
  `num_watches`, `num_forks` + `users.num_stars`, push-mirror sync state) —
  still 64 tables; these are store work behind already-declared ops.
- **UI parity + web seams**: avatar-byhash seam (`bb67087` + mount
  `98d194d`, default-asset guards `239a4ac`), ui-parity-4 (`0b61554` —
  tags + labels pages), ui-parity-5 (`ca4eb58` — milestone detail/edit +
  fork form), the four diffpatch downloads (`79ef809`), the ui-parity-3
  rows landed (`ca81d5a`) — the row-level ledger is
  `ui-parity-survey.md`. The `5d9122c..7016ce9` window adds
  wave-ui-parity-6 (`1b41b60` — the archive download +
  `load-branches-and-tags` aux JSON) and wave-ui-parity-7 (`48101dc` —
  the tags delete write + `/tags/list` aux + the releases edit/delete
  tail).
- **Test/docs**: vitest contention config (`e4ebb9d`), release notes
  (`1c44086`), P0 deploy evidence (`d28d953`, `3d76cc6`), push-mirror SPEC
  (`998a4de`), schema-docstring catch-up (`e6ccf9c`). The
  `5d9122c..7016ce9` window adds: the ws1009 mitigation (`8b0ce41` — the
  `?raw` frozen-contract helper eliminating the 17-runner-death crash
  class) and its sweep completion (`cc196d3` — the last direct contract
  import converted), the SPEC-0001b §5.3.1 as-built repo-copy divergence
  record (`aa95c90` — 14 rows) + the §5.3 annotated-tag fidelity record
  (`eeb8270`), the forks `num_forks` header fix (`945a47d`), the archive
  service-doc convergence note (`9f6b86a`), the auth identity rig
  (`4588475`), ws1009 research (`ff4172a` draft + `aff64a6` measured
  repro), the invariant fixture diet (`3169e33`), P0 deploy evidence
  (`bf8e56f`), the release-notes addendum (`b74b2d2`), and the SPEC-0001b
  §5.3 as-built redesign record (`640c202` — the Worker brokers the copy
  pass, loose closure unconditional).

---

## Dispatchable batches

**None.** The stage-3 batch the regen named as "the only dispatchable work
left" landed (`f38b218`, REG `c9a7ef7`), and no undeclared op rides a landed
store or a table-free service any more. Everything remaining is
FEATURE-ABSENT — declaring it requires the feature, not just a route stub:

- **Actions runtime, 54 ops** (repository 33, organization 7, user 7, admin 7):
  runners, runs, jobs, artifacts, tasks, workflow dispatch/enable,
  registration tokens — upstream `gitea/models/actions/` (`runner.go`,
  `run.go`, `run_job.go`, `run_attempt.go`, `artifact.go`,
  `runner_token.go`, …) + `gitea/services/actions/`. **No CI-runtime table
  exists in our schema** (grep of `apps/worker/src/db/schema.ts` for
  `action_run`/`action_runner`/`action_artifact`/`action_task`/runner-token
  tables: zero hits — the only `action` table there is the activity feed,
  schema.ts:2658). A full SPEC is the precondition; note some list/read ops
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

(The org-projects 21 landed — REG `20512c0` — so organization's remainder is
actions-only.)

### user

The user family's 22 IMPLEMENTABLE-NOW ops (the `/user/projects` +
`/users/{username}/projects` stage-3 set) landed — REG `c9a7ef7` — so the
remainder is actions-only.

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

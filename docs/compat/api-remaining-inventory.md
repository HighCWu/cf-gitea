# Remaining API Inventory — the undeclared 236

Refill ammunition for the wave pool: every operation the frozen contract
declares that our `/api/v1` spec does not, classified by what it would take to
declare it, then ranked into dispatchable batches. Companion to
`ui-parity-survey.md` (the web-UI gap inventory) — this file is the API-side
equivalent.

- **Sources / method**: frozen contract
  `apps/worker/src/compat/contract/v1-swagger.generated.json` (**554** operations:
  repository 229, user 98, organization 88, issue 72, admin 33, miscellaneous 14,
  package 9, notification 7, settings 4) minus the declared set that
  `node scripts/check-openapi.mjs` reports (**318** operations across 203 paths,
  measured 2026-10-25). Diff: **236 undeclared**. Tier-1 is complete
  (78/78 paths, 129/129 ops) — everything here is tier-2/3 by construction.
- **Upstream pin**: `fc4936884584a41931906553d96c2601d750e6ef`
  (v1.22.0-rc1-3919-gfc49368845); every `gitea/…` cite below is that commit.
- **Landed-store references**: `apps/worker/src/db/schema.ts` (49 tables,
  migrations 0000–0018), route modules under `apps/worker/src/api/routes/`,
  services under `apps/worker/src/{services,repos,issues,webhooks}/`.
- **Regenerating the diff**: `node scripts/check-openapi.mjs` prints every
  declared op as `[ok] <METHOD> <path>`; diff against the contract paths object.

## Classification legend

- **IMPLEMENTABLE-NOW** — table-free, or rides an already-migrated store. The
  batch only writes route/service code (plus spec declaration).
- **TABLE-DEPENDENT** — needs new D1 table(s) (or a column). The missing store
  is named with its upstream model pointer; the batch owns one migration
  (numbers below are **provisional** — migrations run 0000–0018 today, next
  free is 0019; assign next-free at merge, drizzle journal regenerated then).
- **RUNTIME-ONLY** — declarable only with documented runtime-only response
  exceptions (the `RUNTIME_ONLY_RESPONSES` table in `scripts/check-openapi.mjs`,
  shared file — orchestrator applies or designates), typically because the
  upstream behavior is degenerate on Workers (no filesystem, no signing key).
- **FEATURE-ABSENT** — gated on a whole feature (actions runtime, package
  registry) that needs its own SPEC; listed with the pointer, not batched.

## Family summary

| Class | repository | organization | user | admin | package | **total** |
|---|---|---|---|---|---|---|
| IMPLEMENTABLE-NOW | 11 | 9 | 13 | 5 | 0 | **38** |
| TABLE-DEPENDENT | 47 | 34 | 39 | 3 | 0 | **123** |
| RUNTIME-ONLY | 6 | 0 | 0 | 5 | 0 | **11** |
| FEATURE-ABSENT | 33 | 7 | 7 | 8 | 9 | **64** |
| **total** | **97** | **50** | **59** | **21** | **9** | **236** |

Notable singletons: `POST /repos/{owner}/{repo}/mirror-sync` is **already
implemented** (`routes/mirror.ts:282`, plain `app.post`) but undeclared — the
only implemented-but-undeclared op in the contract; declaring it is free.

---

## Dispatchable batches (ranked by demand signal)

Demand ranking favors client/tool-visible surface (token management, webhook
scopes, CI-facing secrets) over admin-corner degeneracies. Shared-file note:
every batch needs `src/api/router.ts` registration; schema batches touch
`src/db/schema.ts`; runtime-only batches touch `scripts/check-openapi.mjs` —
these three are shared files, designate an owner or apply at integration.

### Batch 1 — `wave-api-tokens-times-aggregates` (13 ops, table-free)

Highest value-per-effort: everything rides landed stores; no migration.

- `userGetTokens` / `userCreateToken` / `userDeleteAccessToken` — port upstream
  `reqSelfOrAdmin()` + `reqBasicOrRevProxyAuth()` gates
  (`gitea/routers/api/v1/api.go:1067-1072`) over landed
  `personal_access_tokens` (schema.ts:294).
- `repoTrackedTimes`, `userTrackedTimes`, `userCurrentTrackedTimes`,
  `userGetStopWatches` — aggregate reads over landed `tracked_times`
  (schema.ts:1308) + `issue_stopwatches` (schema.ts:1335); the issue-level ops
  on the same tables are already declared.
- `repoMirrorSync` — convert `routes/mirror.ts:282` to a zod-openapi
  declaration (behavior unchanged; rides the landed mirror queue).
- `createOrgRepoDeprecated` — alias path of the declared
  `POST /orgs/{org}/repos` handler.
- `orgDeleteRepos` — org-owner gate + loop over the landed purge machinery
  (`src/repos/purge.ts`).
- `repoSigningKey`, `repoSigningKeySSH` — degenerate 404 "no signing key"
  (`gitea/routers/api/v1/misc/signing.go:14-24`), mirroring the landed global
  pair; needs two `RUNTIME_ONLY_RESPONSES` entries.
- `userVerifyGPGKey` — rides landed `gpg_keys` + the already-ported
  VerificationToken formula (`routes/misc-t3.ts`); the OpenPGP signature
  verification itself is the only real work — ship it last in the batch or
  split it out if the crypto exceeds the slice.

**Files to own**: new `src/api/routes/account-aggregates.ts` (tokens + times +
stopwatches + gpg verify), edits to `src/api/routes/mirror.ts` (declaration
only), new `src/api/routes/admin-org-extras.ts` (alias + orgDeleteRepos +
repo signing keys), `scripts/check-openapi.mjs` (designated).

### Batch 2 — `wave-api-hooks-scopes` (15 ops, table-free)

Org hooks (5) + user hooks (5) + admin system hooks (5). The landed `webhooks`
table already carries all three scopes (`ownerId`, `isSystemWebhook`,
schema.ts:695) and `webhook_deliveries` is scope-agnostic; the declared repo
hooks module (`routes/hooks.ts`) is the template. Port the upstream scope
routers (`gitea/routers/api/v1/org/hook.go`, `user/hook.go`,
`admin/hooks.go`) — the wire payload (`Hook`) is identical across scopes; only
the auth gates differ (org ownership, self, site-admin).

**Files to own**: new `src/api/routes/hooks-scopes.ts` (+ test), extraction of
the shared hook CRUD from `routes/hooks.ts` into `src/api/services/hooks.ts`
(keep `routes/hooks.ts` behavior identical — its tests must stay green).

### Batch 3 — `wave-api-secrets-variables` (23 ops, migration 0019 provisional)

Repo (8) + org (8) + user (7) actions secrets/variables CRUD. New tables
`secrets` + `action_variables` (upstream `gitea/models/secret/secret.go`,
`gitea/models/actions/variable.go` — owner-scoped KV with nullable repo_id).
No runner required: this is the only actions-family surface that works without
the actions runtime, and CI/tooling reads it. Rides landed permission gates.
Payloads: upstream `ActionSecret`/`ActionVariable` list shapes.

**Files to own**: `src/db/schema.ts` + generated migration (designated), new
`src/api/services/secrets-variables.ts`, new `src/api/routes/secrets-variables.ts`
(+ test). Split option: repo+org first (16 ops), user follows (7) as a second
slice over the same service.

### Batch 4 — `wave-api-avatars` (6 ops, table-free)

`POST/DELETE /user/avatar`, `/orgs/{org}/avatar`, `/repos/{owner}/{repo}/avatar`.
R2 blob store (same bucket, `avatars/` key prefix, keyed by owner/repo id) per
the storage-service boundary rule; `users.useCustomAvatar`/`avatar_email`
already landed (schema.ts:265-266). Base64 image decode + upstream size caps
(`gitea/routers/api/v1/user/avatar.go` analogs). Documented divergence:
repo/org "custom avatar set" = R2 key existence (upstream keeps a column).

**Files to own**: new `src/services/avatars.ts`, new `src/api/routes/avatars.ts`
(+ test).

### Batch 5 — `wave-api-deploy-keys` (5 ops, migration 0020 provisional)

Repo deploy keys: `repoListKeys`, `repoGetKey`, `repoCreateKey`,
`repoDeleteKey`, `repoCreateDeployToken`. New `deploy_keys` table (upstream
`gitea/models/deploykey/deploykey.go:25-40`: `key_id`→`public_keys`, `repo_id`,
`token_hash`, `mode`) — the parser/fingerprint helpers it needs are landed
(`services/account-keys.ts`, `public_keys.type=2`, schema.ts:1652). High
tooling demand (CI access without machine users).

**Files to own**: `src/db/schema.ts` + migration (designated), new
`src/api/services/deploy-keys.ts`, new `src/api/routes/deploy-keys.ts` (+ test).

### Batch 6 — `wave-api-projects-repo` (21 ops, migration 0023 provisional — stage 1 of 3)

Stage 1 lands the shared store + repo scope: `projects`, `project_columns`
(upstream `project_board`), `project_issues`, plus `project_workflows` for the
workflow endpoints (upstream `gitea/models/project/{project,column,issue,
workflows}.go`). Column-issue moves ride landed `issues`. One service, three
scopes — stages 2 (org, 21 ops) and 3 (user, 22 ops incl. the extra
`GET /users/{username}/projects`) reuse it verbatim with different gates.

**Files to own**: `src/db/schema.ts` + migration (designated), new
`src/api/services/projects.ts`, new `src/api/routes/projects-repo.ts` (+ test);
stages 2–3 add `routes/projects-org.ts` / `routes/projects-user.ts` (+ tests).

### Batch 7 — `wave-api-push-mirrors` (5 ops, migration 0021 provisional)

`repoListPushMirrors`, `repoGetPushMirrorByRemoteName`, `repoAddPushMirror`,
`repoDeletePushMirror`, `repoPushMirrorSync`. New `push_mirrors` table
(upstream `gitea/models/repo/pushmirror.go`); the sync trigger enqueues on the
landed mirror queue lane and a new consumer performs the push (SPEC-0009
territory — coordinate with that lane before dispatch).

**Files to own**: `src/db/schema.ts` + migration (designated), extension of
`src/services/mirror*` family, new `src/api/routes/push-mirrors.ts` (+ test).

### Batch 8 — `wave-api-tag-protections` (5 ops, migration 0022 provisional)

Tag protection CRUD. New `protected_tags` table (upstream
`gitea/models/git/protected_tag.go`) — a structural mirror of the landed
branch-protection service (`src/services/branch-protection.ts`) and its route
family. Enforcement belongs to the push path (tag delete/create) — same hook
point branch protection uses.

**Files to own**: `src/db/schema.ts` + migration (designated), new
`src/services/tag-protection.ts`, new `src/api/routes/tag-protections.ts`
(+ test), touch point in the push/create-tag path (designate).

### Batch 9 — `wave-api-blocks` (8 ops, migration 0024 provisional)

User blocks (4) + org blocks (4). New `blocking` table (upstream
`gitea/models/user/block.go:24-31` — `blocker_id`+`blockee_id` UNIQUE pair;
blocker may be an org), ported from `gitea/routers/api/v1/user/block.go` +
`org/block.go`.

**Files to own**: `src/db/schema.ts` + migration (designated), new
`src/api/services/blocks.ts`, new `src/api/routes/blocks.ts` (+ test).

### Batch 10 — `wave-api-wiki` (6 ops, table-free engine work)

`repoGetWikiPages`, `repoGetWikiPage`, `repoGetWikiPageRevisions`,
`repoCreateWikiPage`, `repoEditWikiPage`, `repoDeleteWikiPage`. Upstream wiki
is a sibling git repo (`gitea/services/wiki/wiki.go`) — no tables. Reads go
through the engine boundary (blob/log/tree); writes reuse the landed
contents-write machinery against the wiki repo. Needs a short SPEC first
(`specs/wiki.md`) for the wiki-repo storage-key convention and default branch.

**Files to own**: `specs/wiki.md`, new `src/services/wiki.ts`, new
`src/api/routes/wiki.ts` (+ test).

### Batch 11 — `wave-api-admin-degenerate` (5 ops, RUNTIME-ONLY)

`adminCronList` / `adminCronRun` (static task registry — our maintenance task
names; run = enqueue/no-op; upstream
`gitea/routers/api/v1/admin/cron.go` returns in-code definitions) and the
`adminUnadoptedList` / `adminAdoptRepository` / `adminDeleteUnadoptedRepository`
trio (no filesystem → always-empty list, 404s; upstream
`gitea/routers/api/v1/admin/adopt.go` scans disk). Follows the landed
"honest-empty" convention (`orgListTeamActivityFeeds`, routes/org-teams.ts:1213).
Admin-corner demand — dispatch when the pool runs dry, not before.

**Files to own**: new `src/api/routes/admin-degenerate.ts` (+ test),
`scripts/check-openapi.mjs` `RUNTIME_ONLY_RESPONSES` entries (designated).

### Long-tail candidates (17 ops — dispatch as pool-fillers, not primaries)

- **`wave-api-oauth2-apps`** (5, migration 0025 provisional):
  `oauth2_application` table (`gitea/models/auth/oauth2.go`); CRUD only — the
  authorize/token flow is web-UI territory and separate.
- **`wave-api-badges-licenses-template`** (5, migrations 0026–0028
  provisional): admin badges ×3 (`badge` + `user_badge`,
  `gitea/models/user/badge.go`), `repoGetLicenses` (`repo_license` table
  populated at push, `gitea/models/repo/license.go:46-52`), `generateRepo`
  (`repositories.is_template` column + the landed fork/copy pass).
- **`wave-api-git-hooks`** (4, RUNTIME-ONLY): upstream reads server-side hook
  FILES from the repo git dir (`gitea/routers/api/v1/repo/hook.go`) — no fs on
  Workers; a degenerate static-samples list (+ R2-persisted edits, table-free)
  restores UI parity.
- **`wave-api-feeds`** (3, migration 0029 provisional): `action` table
  (`gitea/models/activities/action.go`); insert hooks ride the landed
  `repo-events.ts`/`issue-events.ts` emitters; the heatmap deviation
  (routes/user-read-t2.ts header) is the precedent for honest divergence.
  Heaviest semantics per op in the TABLE-DEPENDENT set — SPEC advised.

### Not batched — FEATURE-ABSENT (64 ops)

- **Actions runtime, 54 ops** (repo 33, org 7, user 7, admin 7): runners,
  runs, jobs, artifacts, tasks, workflow dispatch/enable, registration tokens —
  `gitea/models/actions/`, `gitea/services/actions/`. A full SPEC is a
  precondition; the KV subset (secrets/variables) is Batch 3 and deliberately
  does not depend on it.
- **Package registry, 10 ops** (9 `/packages/*` + `GET /admin/packages`):
  `gitea/models/packages/`, `gitea/modules/packages/` — storage-heavy
  (R2 candidate store per AGENTS); needs its own SPEC before adoption.


### repository

**IMPLEMENTABLE-NOW** (11)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `repoDeleteAvatar` | `DELETE /repos/{owner}/{repo}/avatar` | R2 avatar blob store keyed by owner/repo id — table-free (users.useCustomAvatar/avatar_email already landed, schema.ts:265-266); storage-service layer per AGENTS blob rule |
| `repoDeleteWikiPage` | `DELETE /repos/{owner}/{repo}/wiki/page/{pageName}` | git-engine — wiki is a sibling git repo upstream (services/wiki/wiki.go), table-free; rides landed git-engine write ops |
| `repoTrackedTimes` | `GET /repos/{owner}/{repo}/times` | rides LANDED tracked_times (schema.ts:1308) + issue_stopwatches (schema.ts:1335) — issue-level times/stopwatch ops already declared; these are the aggregate reads |
| `userTrackedTimes` | `GET /repos/{owner}/{repo}/times/{user}` | rides LANDED tracked_times (schema.ts:1308) + issue_stopwatches (schema.ts:1335) — issue-level times/stopwatch ops already declared; these are the aggregate reads |
| `repoGetWikiPage` | `GET /repos/{owner}/{repo}/wiki/page/{pageName}` | git-engine — wiki is a sibling git repo upstream (services/wiki/wiki.go), table-free; rides landed git-engine write ops |
| `repoGetWikiPages` | `GET /repos/{owner}/{repo}/wiki/pages` | git-engine — wiki is a sibling git repo upstream (services/wiki/wiki.go), table-free; rides landed git-engine write ops |
| `repoGetWikiPageRevisions` | `GET /repos/{owner}/{repo}/wiki/revisions/{pageName}` | git-engine — wiki is a sibling git repo upstream (services/wiki/wiki.go), table-free; rides landed git-engine write ops |
| `repoEditWikiPage` | `PATCH /repos/{owner}/{repo}/wiki/page/{pageName}` | git-engine — wiki is a sibling git repo upstream (services/wiki/wiki.go), table-free; rides landed git-engine write ops |
| `repoUpdateAvatar` | `POST /repos/{owner}/{repo}/avatar` | R2 avatar blob store keyed by owner/repo id — table-free (users.useCustomAvatar/avatar_email already landed, schema.ts:265-266); storage-service layer per AGENTS blob rule |
| `repoMirrorSync` | `POST /repos/{owner}/{repo}/mirror-sync` | ALREADY IMPLEMENTED (routes/mirror.ts:282 app.post) — convert to zod-openapi declaration; rides landed mirror service + MIRROR_SYNC_QUEUE |
| `repoCreateWikiPage` | `POST /repos/{owner}/{repo}/wiki/new` | git-engine — wiki is a sibling git repo upstream (services/wiki/wiki.go), table-free; rides landed git-engine write ops |

**TABLE-DEPENDENT** (47)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteRepoSecret` | `DELETE /repos/{owner}/{repo}/actions/secrets/{secretname}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `deleteRepoVariable` | `DELETE /repos/{owner}/{repo}/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `repoDeleteKey` | `DELETE /repos/{owner}/{repo}/keys/{id}` | deploy_key table (upstream models/deploykey/deploykey.go:25-40: key_id→public_keys, repo_id, token_hash, mode) — rides LANDED public_keys (type=2 deploy, schema.ts:1652) |
| `repoDeleteProject` | `DELETE /repos/{owner}/{repo}/projects/{id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoDeleteProjectColumn` | `DELETE /repos/{owner}/{repo}/projects/{id}/columns/{column_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoRemoveIssueFromProjectColumn` | `DELETE /repos/{owner}/{repo}/projects/{id}/columns/{column_id}/issues/{issue_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoDeleteProjectWorkflow` | `DELETE /repos/{owner}/{repo}/projects/{id}/workflows/{workflow_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoDeletePushMirror` | `DELETE /repos/{owner}/{repo}/push_mirrors/{name}` | push_mirror table (upstream models/repo/pushmirror.go) — CRUD + sync trigger rides landed mirror queue/consumer lane (SPEC-0009) |
| `repoDeleteTagProtection` | `DELETE /repos/{owner}/{repo}/tag_protections/{id}` | protected_tags table (upstream models/git/protected_tag.go) — mirror of landed protected_branches service (services/branch-protection.ts) |
| `repoListActionsSecrets` | `GET /repos/{owner}/{repo}/actions/secrets` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `getRepoVariablesList` | `GET /repos/{owner}/{repo}/actions/variables` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `getRepoVariable` | `GET /repos/{owner}/{repo}/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `repoListActivityFeeds` | `GET /repos/{owner}/{repo}/activities/feeds` | action table (upstream models/activities/action.go) — insert hooks ride landed repo-events.ts / issue-events.ts emitters; heatmap already ships the documented deviation precedent |
| `repoListKeys` | `GET /repos/{owner}/{repo}/keys` | deploy_key table (upstream models/deploykey/deploykey.go:25-40: key_id→public_keys, repo_id, token_hash, mode) — rides LANDED public_keys (type=2 deploy, schema.ts:1652) |
| `repoGetKey` | `GET /repos/{owner}/{repo}/keys/{id}` | deploy_key table (upstream models/deploykey/deploykey.go:25-40: key_id→public_keys, repo_id, token_hash, mode) — rides LANDED public_keys (type=2 deploy, schema.ts:1652) |
| `repoGetLicenses` | `GET /repos/{owner}/{repo}/licenses` | repo_license table populated at push (upstream models/repo/license.go:46-52 UpdateRepoLicenses) — detection rides landed engine tree reads |
| `repoListProjects` | `GET /repos/{owner}/{repo}/projects` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoGetProject` | `GET /repos/{owner}/{repo}/projects/{id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoListProjectColumns` | `GET /repos/{owner}/{repo}/projects/{id}/columns` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoGetProjectColumn` | `GET /repos/{owner}/{repo}/projects/{id}/columns/{column_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoListProjectColumnIssues` | `GET /repos/{owner}/{repo}/projects/{id}/columns/{column_id}/issues` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoListProjectWorkflows` | `GET /repos/{owner}/{repo}/projects/{id}/workflows` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoGetProjectWorkflow` | `GET /repos/{owner}/{repo}/projects/{id}/workflows/{workflow_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoListPushMirrors` | `GET /repos/{owner}/{repo}/push_mirrors` | push_mirror table (upstream models/repo/pushmirror.go) — CRUD + sync trigger rides landed mirror queue/consumer lane (SPEC-0009) |
| `repoGetPushMirrorByRemoteName` | `GET /repos/{owner}/{repo}/push_mirrors/{name}` | push_mirror table (upstream models/repo/pushmirror.go) — CRUD + sync trigger rides landed mirror queue/consumer lane (SPEC-0009) |
| `repoListTagProtection` | `GET /repos/{owner}/{repo}/tag_protections` | protected_tags table (upstream models/git/protected_tag.go) — mirror of landed protected_branches service (services/branch-protection.ts) |
| `repoGetTagProtection` | `GET /repos/{owner}/{repo}/tag_protections/{id}` | protected_tags table (upstream models/git/protected_tag.go) — mirror of landed protected_branches service (services/branch-protection.ts) |
| `repoEditProject` | `PATCH /repos/{owner}/{repo}/projects/{id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoEditProjectColumn` | `PATCH /repos/{owner}/{repo}/projects/{id}/columns/{column_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoEditProjectWorkflow` | `PATCH /repos/{owner}/{repo}/projects/{id}/workflows/{workflow_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoEditTagProtection` | `PATCH /repos/{owner}/{repo}/tag_protections/{id}` | protected_tags table (upstream models/git/protected_tag.go) — mirror of landed protected_branches service (services/branch-protection.ts) |
| `createRepoVariable` | `POST /repos/{owner}/{repo}/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `repoCreateKey` | `POST /repos/{owner}/{repo}/keys` | deploy_key table (upstream models/deploykey/deploykey.go:25-40: key_id→public_keys, repo_id, token_hash, mode) — rides LANDED public_keys (type=2 deploy, schema.ts:1652) |
| `repoCreateDeployToken` | `POST /repos/{owner}/{repo}/keys/tokens` | deploy_key table (upstream models/deploykey/deploykey.go:25-40: key_id→public_keys, repo_id, token_hash, mode) — rides LANDED public_keys (type=2 deploy, schema.ts:1652) |
| `repoCreateProject` | `POST /repos/{owner}/{repo}/projects` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoCreateProjectColumn` | `POST /repos/{owner}/{repo}/projects/{id}/columns` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoSetDefaultProjectColumn` | `POST /repos/{owner}/{repo}/projects/{id}/columns/{column_id}/default` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoAddIssueToProjectColumn` | `POST /repos/{owner}/{repo}/projects/{id}/columns/{column_id}/issues/{issue_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoMoveProjectColumns` | `POST /repos/{owner}/{repo}/projects/{id}/columns/move` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoMoveProjectIssue` | `POST /repos/{owner}/{repo}/projects/{id}/issues/{issue_id}/move` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoCreateProjectWorkflow` | `POST /repos/{owner}/{repo}/projects/{id}/workflows` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `repoAddPushMirror` | `POST /repos/{owner}/{repo}/push_mirrors` | push_mirror table (upstream models/repo/pushmirror.go) — CRUD + sync trigger rides landed mirror queue/consumer lane (SPEC-0009) |
| `repoPushMirrorSync` | `POST /repos/{owner}/{repo}/push_mirrors-sync` | push_mirror table (upstream models/repo/pushmirror.go) — CRUD + sync trigger rides landed mirror queue/consumer lane (SPEC-0009) |
| `repoCreateTagProtection` | `POST /repos/{owner}/{repo}/tag_protections` | protected_tags table (upstream models/git/protected_tag.go) — mirror of landed protected_branches service (services/branch-protection.ts) |
| `generateRepo` | `POST /repos/{template_owner}/{template_repo}/generate` | repositories.is_template column (upstream repository.template) — generation itself rides landed fork/copy engine pass (src/repos/fork-task.ts) |
| `updateRepoSecret` | `PUT /repos/{owner}/{repo}/actions/secrets/{secretname}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `updateRepoVariable` | `PUT /repos/{owner}/{repo}/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |

**RUNTIME-ONLY** (6)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `repoDeleteGitHook` | `DELETE /repos/{owner}/{repo}/hooks/git/{id}` | degenerate: upstream reads server-side hook FILES from the repo git dir (routers/api/v1/repo/hook.go) — no fs on Workers; static default-hook samples possible |
| `repoListGitHooks` | `GET /repos/{owner}/{repo}/hooks/git` | degenerate: upstream reads server-side hook FILES from the repo git dir (routers/api/v1/repo/hook.go) — no fs on Workers; static default-hook samples possible |
| `repoGetGitHook` | `GET /repos/{owner}/{repo}/hooks/git/{id}` | degenerate: upstream reads server-side hook FILES from the repo git dir (routers/api/v1/repo/hook.go) — no fs on Workers; static default-hook samples possible |
| `repoSigningKey` | `GET /repos/{owner}/{repo}/signing-key.gpg` | degenerate 404 no-signing-key (routers/api/v1/misc/signing.go:14-24), same class as the landed global pair; needs a RUNTIME_ONLY_RESPONSES-style exception entry |
| `repoSigningKeySSH` | `GET /repos/{owner}/{repo}/signing-key.pub` | degenerate 404 no-signing-key (routers/api/v1/misc/signing.go:14-24), same class as the landed global pair; needs a RUNTIME_ONLY_RESPONSES-style exception entry |
| `repoEditGitHook` | `PATCH /repos/{owner}/{repo}/hooks/git/{id}` | degenerate: upstream reads server-side hook FILES from the repo git dir (routers/api/v1/repo/hook.go) — no fs on Workers; static default-hook samples possible |

**FEATURE-ABSENT** (33)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteArtifact` | `DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `deleteRepoRunner` | `DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `deleteActionRun` | `DELETE /repos/{owner}/{repo}/actions/runs/{run}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getArtifacts` | `GET /repos/{owner}/{repo}/actions/artifacts` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getArtifact` | `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `downloadArtifact` | `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `listWorkflowJobs` | `GET /repos/{owner}/{repo}/actions/jobs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getWorkflowJob` | `GET /repos/{owner}/{repo}/actions/jobs/{job_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `downloadActionsRunJobLogs` | `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getRepoRunners` | `GET /repos/{owner}/{repo}/actions/runners` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getRepoRunner` | `GET /repos/{owner}/{repo}/actions/runners/{runner_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getWorkflowRuns` | `GET /repos/{owner}/{repo}/actions/runs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `GetWorkflowRun` | `GET /repos/{owner}/{repo}/actions/runs/{run}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getArtifactsOfRun` | `GET /repos/{owner}/{repo}/actions/runs/{run}/artifacts` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getWorkflowRunAttempt` | `GET /repos/{owner}/{repo}/actions/runs/{run}/attempts/{attempt}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `listWorkflowRunAttemptJobs` | `GET /repos/{owner}/{repo}/actions/runs/{run}/attempts/{attempt}/jobs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `listWorkflowRunJobs` | `GET /repos/{owner}/{repo}/actions/runs/{run}/jobs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getWorkflowRunLogs` | `GET /repos/{owner}/{repo}/actions/runs/{run}/logs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `ListActionTasks` | `GET /repos/{owner}/{repo}/actions/tasks` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `ActionsListRepositoryWorkflows` | `GET /repos/{owner}/{repo}/actions/workflows` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `ActionsGetWorkflow` | `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `ActionsListWorkflowRuns` | `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `updateRepoRunner` | `PATCH /repos/{owner}/{repo}/actions/runners/{runner_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `repoCreateRunnerRegistrationToken` | `POST /repos/{owner}/{repo}/actions/runners/registration-token` | actions runner tokens (upstream models/actions/runner_token.go) |
| `approveWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/approve` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `cancelWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/cancel` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `forceCancelWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/force-cancel` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `rerunWorkflowJob` | `POST /repos/{owner}/{repo}/actions/runs/{run}/jobs/{job_id}/rerun` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `rerunWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/rerun` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `rerunFailedWorkflowRun` | `POST /repos/{owner}/{repo}/actions/runs/{run}/rerun-failed-jobs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `ActionsDispatchWorkflow` | `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `ActionsDisableWorkflow` | `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `ActionsEnableWorkflow` | `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |


### organization

**IMPLEMENTABLE-NOW** (9)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `orgDeleteAvatar` | `DELETE /orgs/{org}/avatar` | R2 avatar blob store keyed by owner/repo id — table-free (users.useCustomAvatar/avatar_email already landed, schema.ts:265-266); storage-service layer per AGENTS blob rule |
| `orgDeleteHook` | `DELETE /orgs/{org}/hooks/{id}` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |
| `orgDeleteRepos` | `DELETE /orgs/{org}/repos` | rides LANDED repositories + purge machinery (src/repos/purge.ts) — org-owner gate, loop deleteOrgRepo |
| `orgListHooks` | `GET /orgs/{org}/hooks` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |
| `orgGetHook` | `GET /orgs/{org}/hooks/{id}` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |
| `orgEditHook` | `PATCH /orgs/{org}/hooks/{id}` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |
| `createOrgRepoDeprecated` | `POST /org/{org}/repos` | deprecated alias of the DECLARED POST /orgs/{org}/repos (routes/org-repos.ts) — same handler, alternate path constant |
| `orgUpdateAvatar` | `POST /orgs/{org}/avatar` | R2 avatar blob store keyed by owner/repo id — table-free (users.useCustomAvatar/avatar_email already landed, schema.ts:265-266); storage-service layer per AGENTS blob rule |
| `orgCreateHook` | `POST /orgs/{org}/hooks` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |

**TABLE-DEPENDENT** (34)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteOrgSecret` | `DELETE /orgs/{org}/actions/secrets/{secretname}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `deleteOrgVariable` | `DELETE /orgs/{org}/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `organizationUnblockUser` | `DELETE /orgs/{org}/blocks/{username}` | blocking table (upstream models/user/block.go:24-31 Blocking: blocker_id+blockee_id UNIQUE) — one migration covers user+org scopes; rides landed users/orgs |
| `orgDeleteProject` | `DELETE /orgs/{org}/projects/{id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgDeleteProjectColumn` | `DELETE /orgs/{org}/projects/{id}/columns/{column_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgRemoveIssueFromProjectColumn` | `DELETE /orgs/{org}/projects/{id}/columns/{column_id}/issues/{issue_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgDeleteProjectWorkflow` | `DELETE /orgs/{org}/projects/{id}/workflows/{workflow_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgListActionsSecrets` | `GET /orgs/{org}/actions/secrets` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `getOrgVariablesList` | `GET /orgs/{org}/actions/variables` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `getOrgVariable` | `GET /orgs/{org}/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `orgListActivityFeeds` | `GET /orgs/{org}/activities/feeds` | action table (upstream models/activities/action.go) — insert hooks ride landed repo-events.ts / issue-events.ts emitters; heatmap already ships the documented deviation precedent |
| `organizationListBlocks` | `GET /orgs/{org}/blocks` | blocking table (upstream models/user/block.go:24-31 Blocking: blocker_id+blockee_id UNIQUE) — one migration covers user+org scopes; rides landed users/orgs |
| `organizationCheckUserBlock` | `GET /orgs/{org}/blocks/{username}` | blocking table (upstream models/user/block.go:24-31 Blocking: blocker_id+blockee_id UNIQUE) — one migration covers user+org scopes; rides landed users/orgs |
| `orgListProjects` | `GET /orgs/{org}/projects` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgGetProject` | `GET /orgs/{org}/projects/{id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgListProjectColumns` | `GET /orgs/{org}/projects/{id}/columns` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgGetProjectColumn` | `GET /orgs/{org}/projects/{id}/columns/{column_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgListProjectColumnIssues` | `GET /orgs/{org}/projects/{id}/columns/{column_id}/issues` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgListProjectWorkflows` | `GET /orgs/{org}/projects/{id}/workflows` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgGetProjectWorkflow` | `GET /orgs/{org}/projects/{id}/workflows/{workflow_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgEditProject` | `PATCH /orgs/{org}/projects/{id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgEditProjectColumn` | `PATCH /orgs/{org}/projects/{id}/columns/{column_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgEditProjectWorkflow` | `PATCH /orgs/{org}/projects/{id}/workflows/{workflow_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `createOrgVariable` | `POST /orgs/{org}/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `orgCreateProject` | `POST /orgs/{org}/projects` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgCreateProjectColumn` | `POST /orgs/{org}/projects/{id}/columns` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgSetDefaultProjectColumn` | `POST /orgs/{org}/projects/{id}/columns/{column_id}/default` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgAddIssueToProjectColumn` | `POST /orgs/{org}/projects/{id}/columns/{column_id}/issues/{issue_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgMoveProjectColumns` | `POST /orgs/{org}/projects/{id}/columns/move` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgMoveProjectIssue` | `POST /orgs/{org}/projects/{id}/issues/{issue_id}/move` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `orgCreateProjectWorkflow` | `POST /orgs/{org}/projects/{id}/workflows` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `updateOrgSecret` | `PUT /orgs/{org}/actions/secrets/{secretname}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `updateOrgVariable` | `PUT /orgs/{org}/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `organizationBlockUser` | `PUT /orgs/{org}/blocks/{username}` | blocking table (upstream models/user/block.go:24-31 Blocking: blocker_id+blockee_id UNIQUE) — one migration covers user+org scopes; rides landed users/orgs |

**FEATURE-ABSENT** (7)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteOrgRunner` | `DELETE /orgs/{org}/actions/runners/{runner_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getOrgWorkflowJobs` | `GET /orgs/{org}/actions/jobs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getOrgRunners` | `GET /orgs/{org}/actions/runners` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getOrgRunner` | `GET /orgs/{org}/actions/runners/{runner_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getOrgWorkflowRuns` | `GET /orgs/{org}/actions/runs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `updateOrgRunner` | `PATCH /orgs/{org}/actions/runners/{runner_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `orgCreateRunnerRegistrationToken` | `POST /orgs/{org}/actions/runners/registration-token` | actions runner tokens (upstream models/actions/runner_token.go) |


### user

**IMPLEMENTABLE-NOW** (13)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `userDeleteAvatar` | `DELETE /user/avatar` | R2 avatar blob store keyed by owner/repo id — table-free (users.useCustomAvatar/avatar_email already landed, schema.ts:265-266); storage-service layer per AGENTS blob rule |
| `userDeleteHook` | `DELETE /user/hooks/{id}` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |
| `userDeleteAccessToken` | `DELETE /users/{username}/tokens/{token}` | rides LANDED personal_access_tokens (schema.ts:294); upstream reqSelfOrAdmin + reqBasicOrRevProxyAuth (routers/api/v1/api.go:1067-1072) |
| `userListHooks` | `GET /user/hooks` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |
| `userGetHook` | `GET /user/hooks/{id}` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |
| `userGetStopWatches` | `GET /user/stopwatches` | rides LANDED tracked_times (schema.ts:1308) + issue_stopwatches (schema.ts:1335) — issue-level times/stopwatch ops already declared; these are the aggregate reads |
| `userCurrentTrackedTimes` | `GET /user/times` | rides LANDED tracked_times (schema.ts:1308) + issue_stopwatches (schema.ts:1335) — issue-level times/stopwatch ops already declared; these are the aggregate reads |
| `userGetTokens` | `GET /users/{username}/tokens` | rides LANDED personal_access_tokens (schema.ts:294); upstream reqSelfOrAdmin + reqBasicOrRevProxyAuth (routers/api/v1/api.go:1067-1072) |
| `userEditHook` | `PATCH /user/hooks/{id}` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |
| `userUpdateAvatar` | `POST /user/avatar` | R2 avatar blob store keyed by owner/repo id — table-free (users.useCustomAvatar/avatar_email already landed, schema.ts:265-266); storage-service layer per AGENTS blob rule |
| `userVerifyGPGKey` | `POST /user/gpg_key_verify` | rides LANDED gpg_keys (schema.ts:1698) + the ported VerificationToken formula (routes/misc-t3.ts) — needs OpenPGP signature verification (table-free, crypto-heavy) |
| `userCreateHook` | `POST /user/hooks` | webhooks table ownerId scope (landed, schema.ts:695) — same shape as declared repo hooks (routes/hooks.ts); delivery rides webhook_deliveries |
| `userCreateToken` | `POST /users/{username}/tokens` | rides LANDED personal_access_tokens (schema.ts:294); upstream reqSelfOrAdmin + reqBasicOrRevProxyAuth (routers/api/v1/api.go:1067-1072) |

**TABLE-DEPENDENT** (39)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteUserSecret` | `DELETE /user/actions/secrets/{secretname}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `deleteUserVariable` | `DELETE /user/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `userDeleteOAuth2Application` | `DELETE /user/applications/oauth2/{id}` | oauth2_application table (upstream models/auth/oauth2.go) — CRUD only; full OAuth2 authorize flow is a separate feature (web UI, not /api/v1) |
| `userUnblockUser` | `DELETE /user/blocks/{username}` | blocking table (upstream models/user/block.go:24-31 Blocking: blocker_id+blockee_id UNIQUE) — one migration covers user+org scopes; rides landed users/orgs |
| `userCurrentDeleteProject` | `DELETE /user/projects/{id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentDeleteProjectColumn` | `DELETE /user/projects/{id}/columns/{column_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentRemoveIssueFromProjectColumn` | `DELETE /user/projects/{id}/columns/{column_id}/issues/{issue_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentDeleteProjectWorkflow` | `DELETE /user/projects/{id}/workflows/{workflow_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `getUserVariablesList` | `GET /user/actions/variables` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `getUserVariable` | `GET /user/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `userGetOauth2Application` | `GET /user/applications/oauth2` | oauth2_application table (upstream models/auth/oauth2.go) — CRUD only; full OAuth2 authorize flow is a separate feature (web UI, not /api/v1) |
| `userGetOAuth2Application` | `GET /user/applications/oauth2/{id}` | oauth2_application table (upstream models/auth/oauth2.go) — CRUD only; full OAuth2 authorize flow is a separate feature (web UI, not /api/v1) |
| `userListBlocks` | `GET /user/blocks` | blocking table (upstream models/user/block.go:24-31 Blocking: blocker_id+blockee_id UNIQUE) — one migration covers user+org scopes; rides landed users/orgs |
| `userCheckUserBlock` | `GET /user/blocks/{username}` | blocking table (upstream models/user/block.go:24-31 Blocking: blocker_id+blockee_id UNIQUE) — one migration covers user+org scopes; rides landed users/orgs |
| `userCurrentListProjects` | `GET /user/projects` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentGetProject` | `GET /user/projects/{id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentListProjectColumns` | `GET /user/projects/{id}/columns` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentGetProjectColumn` | `GET /user/projects/{id}/columns/{column_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentListProjectColumnIssues` | `GET /user/projects/{id}/columns/{column_id}/issues` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentListProjectWorkflows` | `GET /user/projects/{id}/workflows` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentGetProjectWorkflow` | `GET /user/projects/{id}/workflows/{workflow_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userListActivityFeeds` | `GET /users/{username}/activities/feeds` | action table (upstream models/activities/action.go) — insert hooks ride landed repo-events.ts / issue-events.ts emitters; heatmap already ships the documented deviation precedent |
| `userListProjects` | `GET /users/{username}/projects` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userUpdateOAuth2Application` | `PATCH /user/applications/oauth2/{id}` | oauth2_application table (upstream models/auth/oauth2.go) — CRUD only; full OAuth2 authorize flow is a separate feature (web UI, not /api/v1) |
| `userCurrentEditProject` | `PATCH /user/projects/{id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentEditProjectColumn` | `PATCH /user/projects/{id}/columns/{column_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentEditProjectWorkflow` | `PATCH /user/projects/{id}/workflows/{workflow_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `createUserVariable` | `POST /user/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `userCreateOAuth2Application` | `POST /user/applications/oauth2` | oauth2_application table (upstream models/auth/oauth2.go) — CRUD only; full OAuth2 authorize flow is a separate feature (web UI, not /api/v1) |
| `userCurrentCreateProject` | `POST /user/projects` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentCreateProjectColumn` | `POST /user/projects/{id}/columns` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentSetDefaultProjectColumn` | `POST /user/projects/{id}/columns/{column_id}/default` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentAddIssueToProjectColumn` | `POST /user/projects/{id}/columns/{column_id}/issues/{issue_id}` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentMoveProjectColumns` | `POST /user/projects/{id}/columns/move` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentMoveProjectIssue` | `POST /user/projects/{id}/issues/{issue_id}/move` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `userCurrentCreateProjectWorkflow` | `POST /user/projects/{id}/workflows` | project + project_board + project_issue tables (upstream models/project/project.go, column.go, issue.go) — ONE shared migration covers user/org/repo scopes; rides landed issues for column-issue moves |
| `updateUserSecret` | `PUT /user/actions/secrets/{secretname}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `updateUserVariable` | `PUT /user/actions/variables/{variablename}` | secret + action_variable KV tables (upstream models/secret/secret.go, models/actions/variable.go) — CRUD only, no runner needed; rides landed owner/repo visibility gates |
| `userBlockUser` | `PUT /user/blocks/{username}` | blocking table (upstream models/user/block.go:24-31 Blocking: blocker_id+blockee_id UNIQUE) — one migration covers user+org scopes; rides landed users/orgs |

**FEATURE-ABSENT** (7)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteUserRunner` | `DELETE /user/actions/runners/{runner_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getUserWorkflowJobs` | `GET /user/actions/jobs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getUserRunners` | `GET /user/actions/runners` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getUserRunner` | `GET /user/actions/runners/{runner_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `getUserWorkflowRuns` | `GET /user/actions/runs` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `updateUserRunner` | `PATCH /user/actions/runners/{runner_id}` | actions runtime (upstream models/actions/ — runner/run/job/artifact/task tables + services/actions) |
| `userCreateRunnerRegistrationToken` | `POST /user/actions/runners/registration-token` | actions runner tokens (upstream models/actions/runner_token.go) |


### admin

**IMPLEMENTABLE-NOW** (5)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `adminDeleteHook` | `DELETE /admin/hooks/{id}` | webhooks table isSystemWebhook=true + ownerId=0 (landed, schema.ts:695); delivery rides webhook_deliveries |
| `adminListHooks` | `GET /admin/hooks` | webhooks table isSystemWebhook=true + ownerId=0 (landed, schema.ts:695); delivery rides webhook_deliveries |
| `adminGetHook` | `GET /admin/hooks/{id}` | webhooks table isSystemWebhook=true + ownerId=0 (landed, schema.ts:695); delivery rides webhook_deliveries |
| `adminEditHook` | `PATCH /admin/hooks/{id}` | webhooks table isSystemWebhook=true + ownerId=0 (landed, schema.ts:695); delivery rides webhook_deliveries |
| `adminCreateHook` | `POST /admin/hooks` | webhooks table isSystemWebhook=true + ownerId=0 (landed, schema.ts:695); delivery rides webhook_deliveries |

**TABLE-DEPENDENT** (3)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `adminDeleteUserBadges` | `DELETE /admin/users/{username}/badges` | badge + user_badge tables (upstream models/user/badge.go); rides landed users |
| `adminListUserBadges` | `GET /admin/users/{username}/badges` | badge + user_badge tables (upstream models/user/badge.go); rides landed users |
| `adminAddUserBadges` | `POST /admin/users/{username}/badges` | badge + user_badge tables (upstream models/user/badge.go); rides landed users |

**RUNTIME-ONLY** (5)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `adminDeleteUnadoptedRepository` | `DELETE /admin/unadopted/{owner}/{repo}` | degenerate: no filesystem — list is always empty, adopt/delete 404 (upstream routers/api/v1/admin/adopt.go scans disk) |
| `adminCronList` | `GET /admin/cron` | degenerate: static cron-task registry + enqueue no-op (upstream routers/api/v1/admin/cron.go returns in-code definitions) |
| `adminUnadoptedList` | `GET /admin/unadopted` | degenerate: no filesystem — list is always empty, adopt/delete 404 (upstream routers/api/v1/admin/adopt.go scans disk) |
| `adminCronRun` | `POST /admin/cron/{task}` | degenerate: static cron-task registry + enqueue no-op (upstream routers/api/v1/admin/cron.go returns in-code definitions) |
| `adminAdoptRepository` | `POST /admin/unadopted/{owner}/{repo}` | degenerate: no filesystem — list is always empty, adopt/delete 404 (upstream routers/api/v1/admin/adopt.go scans disk) |

**FEATURE-ABSENT** (8)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deleteAdminRunner` | `DELETE /admin/actions/runners/{runner_id}` | actions runtime (upstream models/actions/, services/actions/) |
| `listAdminWorkflowJobs` | `GET /admin/actions/jobs` | actions runtime (upstream models/actions/, services/actions/) |
| `getAdminRunners` | `GET /admin/actions/runners` | actions runtime (upstream models/actions/, services/actions/) |
| `getAdminRunner` | `GET /admin/actions/runners/{runner_id}` | actions runtime (upstream models/actions/, services/actions/) |
| `listAdminWorkflowRuns` | `GET /admin/actions/runs` | actions runtime (upstream models/actions/, services/actions/) |
| `adminListPackages` | `GET /admin/packages` | packages (upstream models/packages/) |
| `updateAdminRunner` | `PATCH /admin/actions/runners/{runner_id}` | actions runtime (upstream models/actions/, services/actions/) |
| `adminCreateRunnerRegistrationToken` | `POST /admin/actions/runners/registration-token` | actions runtime (upstream models/actions/, services/actions/) |


### package

**FEATURE-ABSENT** (9)

| Operation | `METHOD path` | Rides / missing / pointer |
|---|---|---|
| `deletePackage` | `DELETE /packages/{owner}/{type}/{name}` | package registry (upstream models/packages/, modules/packages/) — needs SPEC before adoption (R2 candidate store) |
| `deletePackageVersion` | `DELETE /packages/{owner}/{type}/{name}/{version}` | package registry (upstream models/packages/, modules/packages/) — needs SPEC before adoption (R2 candidate store) |
| `listPackages` | `GET /packages/{owner}` | package registry (upstream models/packages/, modules/packages/) — needs SPEC before adoption (R2 candidate store) |
| `listPackageVersions` | `GET /packages/{owner}/{type}/{name}` | package registry (upstream models/packages/, modules/packages/) — needs SPEC before adoption (R2 candidate store) |
| `getLatestPackageVersion` | `GET /packages/{owner}/{type}/{name}/-/latest` | package registry (upstream models/packages/, modules/packages/) — needs SPEC before adoption (R2 candidate store) |
| `getPackage` | `GET /packages/{owner}/{type}/{name}/{version}` | package registry (upstream models/packages/, modules/packages/) — needs SPEC before adoption (R2 candidate store) |
| `listPackageFiles` | `GET /packages/{owner}/{type}/{name}/{version}/files` | package registry (upstream models/packages/, modules/packages/) — needs SPEC before adoption (R2 candidate store) |
| `linkPackage` | `POST /packages/{owner}/{type}/{name}/-/link/{repo_name}` | package registry (upstream models/packages/, modules/packages/) — needs SPEC before adoption (R2 candidate store) |
| `unlinkPackage` | `POST /packages/{owner}/{type}/{name}/-/unlink` | package registry (upstream models/packages/, modules/packages/) — needs SPEC before adoption (R2 candidate store) |


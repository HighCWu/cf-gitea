# Table-alignment audit — the ADR-0007 census (FW, 2026-11-03)

Status: complete (read-only audit; this file is its only artifact) ·
Mandate: ADR-0007 consequence 2 ("FN's table audit builds the drift backlog
under this vocabulary") · Upstream pin: `gitea/` @ `fc4936884584` ·
Our side: `apps/worker/src/db/schema.ts` at the working tree that carries
FM's in-flight `action_schedule` + `action_schedule_spec` (marked below).

This audit REGENERATES and REPLACES the lost FN chat report. Every number
here was re-derived from the two sources of truth (upstream xorm model
registration; our Drizzle schema) — nothing was carried from the lost
report except the fixed FN-1 row, which was re-verified against the same
sources and found accurate.

## Headline

- **Upstream tables: 117** — 117 `db.RegisterModel(...)` calls across
  `gitea/models/**` (+ none from `modules/`; `modules/repository` and
  `modules/lfs` structs piggyback on already-registered tables), all
  **distinct** SQL table names under `names.GonicMapper{}`.
- **Our tables: 107** exported `sqliteTable` definitions in
  `apps/worker/src/db/schema.ts`, all with explicit snake_case SQL names.
- **Verdicts over the 117 upstream tables:**
  - **47 aligned** (structure faithful; only the blanket families of §2 apply)
  - **22 intentional-recorded** (a SPEC or code-level record owns the divergence)
  - **26 drift** (accidental divergence — the migration backlog, §5/FN)
  - **22 missing-table** (no counterpart; §3.3 splits the no-reader arm)
  - *(0 platform-adapted PAIRS — platform adaptation shows up in the blanket
    families of §2 and in the missing-table rows, not as whole-table rewrites)*
- **Ours-extras: 12** tables with no upstream counterpart (§3.4).
- The lost report's "~115 tables / ~60 drifted columns / 4 missing tables"
  is **superseded**: this census counts 117 / 69 table-specific drift
  columns (+ the blanket families and the 26-column `repositories`
  residual) / **22 missing tables**. The 4-missing-table figure undercounts
  by counting only data tables a reader would touch; this census counts
  every registered upstream table.
- **Recommended first three migration units: FN-1 (pull_requests.status
  stored-enum swap), FN-3 (review_state.updated_files — the per-file
  viewed map), FN-2 (comments mutation-metadata completion).** See §5.
  FN-1 was found ALREADY LANDING in the worktree when this audit closed
  (migration 0064 + the schema.ts:588-596 re-map — verified correct); the
  recommended OPENING units for the next wave are therefore FN-3, FN-2,
  and FN-6 (repo_units completion).

## 1. Method (reproducible)

Upstream enumeration:

```bash
# the registered models — 117 rows
grep -rn "RegisterModel(" gitea/models/ gitea/modules/ --include="*.go" \
  | grep -v _test.go | grep -v "func RegisterModel"
# 117 = every db.RegisterModel call; models/db/engine_init.go:127
# SyncAllTables() syncs EXACTLY these beans, so registration == table.
# explicit table-name overrides (the two Redirect and two Setting structs,
# Organization->user, Column->project_board, AutoMerge->pull_auto_merge, ...):
grep -rn -A2 ") TableName() string" gitea/models/ gitea/modules/
# the name mapper (engine_init.go:55 `xe.SetMapper(names.GonicMapper{})`):
sed -n 50,58p gitea/models/db/engine_init.go
```

Column shapes come from the xorm struct fields + tags, mapped with xorm's
`gonicCasedName` algorithm (`names/mapper.go`, fetched from the xorm v1
upstream because the module cache is absent; ported verbatim into a scratch
parser). That mapper is why upstream has quirk names like `redirect_ur_is`
(`RedirectURIs`), `team_i_ds` (`TeamIDs`), `hash_m_d5` (`HashMD5`) — the
trailing-lowercase-after-initialism rule splits before the final letter
run. Embedded fields: `LFSMetaObject` extends `lfs.Pointer`
(`gitea/modules/lfs/shared.go:41-44` → `oid`, `size`); the five
`*Index`/`*Version` structs are `db.ResourceIndex` aliases
(`gitea/models/db/index.go:17-20` → `group_id` pk + `max_index`).

Our enumeration:

```bash
# exported Drizzle tables — 107
grep -c "export const .* = sqliteTable(" apps/worker/src/db/schema.ts
# (a plain [a-zA-Z]* glob undercounts by 3 — oauth2Applications etc. carry digits)
```

Each definition's explicit SQL name, columns, nullability, defaults and
type modes were parsed from `schema.ts` (every column carries an explicit
snake_case name — zero inferred names). Comparison: per-table column diff
(missing / ours-extra / rename pairs / type-family / nullability /
defaults), with xorm type tags (`VARCHAR(n)`, `TEXT`, `LONGBLOB`, `JSON`,
`SMALLINT`, named int enums, `[]byte`) mapped to SQLite families and
Drizzle `text/integer/blob` + `mode: "boolean"` mapped likewise.

Both parsers and the comparator were scratch scripts (session `/tmp`,
not committed); the method above is the full algorithm. Re-run cost is one
session of parsing; the durable record is this document.

## 2. The blanket families (classified once, applies across the census)

These divergence classes touch most tables; classifying them per-table
would drown the real drift. Each is classified once here, with its cite;
table verdicts in §3 assume them.

1. **The id family — intentional-recorded, and honestly NOT
   platform-forced.** `repositories.id` is TEXT; every column referencing
   it (`repo_id`, `head_repo_id`, `base_repo_id`, `fork_parent`,
   `redirect_repo_id`, `workflow_repo_id`, `source_repo_id`,
   `workflow_source_repo_id`, `scope_id`, ...) is TEXT where upstream is
   int64 (25+ columns; the diff's dominant type family). D1/SQLite CAN
   express int64 ids — this is not a platform impossibility. The record is
   ADR-0007 itself (item 2: "our TEXT `repositories.id` id space vs
   upstream's int64, the id-space fact K11 pinned in `3ed025d`") — an
   **intentional-recorded** classification, not platform-adapted. Corollary
   flag: the record pins `repositories.id`; every NEW table/column that
   joins the TEXT id family inherits it, but any TEXT id NOT derived from
   that family is **candidate drift** and needs its own record.
   Non-referencing PKs (`users.id`, `issues.id`, ...) stay INTEGER
   autoincrement — same family as upstream's `pk autoincr`, no drift.
2. **Plural table names — intentional-recorded.** Upstream `user` /
   `notice` / `access_token` → ours `users` / `system_notices` /
   `personal_access_tokens`; the convention is stated in SPEC-0018 §4.1
   ("the drizzle schema's plural convention applies") and applied
   schema-wide.
3. **TEXT enum convention — intentional-recorded.** Upstream int enums →
   ours text enums (`status`, `visibility`, `type`, `mode`, `state`,
   `origin`, `scope_type`, `authorize`, `anonymous_access_mode`, ...);
   recorded as the porting convention in SPEC-0012 (§"Column-for-column
   ports ... TEXT enum convention") and SPEC-0016 §(packages port), and
   applied schema-wide. Counter-examples that deliberately kept INTEGER are
   recorded per-table (e.g. `system_notices.type`, SPEC-0018 §4.1).
4. **Boolean storage — same family, no drift.** Upstream xorm `bool` and
   ours `integer({ mode: "boolean" })` are both SQLite INTEGER 0/1; a few
   of our older columns are plain `integer` 0/1 without the mode wrapper
   (`comments.removed_assignee`, `users.repo_admin_change_team_access`,
   `repositories.close_issues_via_commit_in_any_branch`) — storage-equal,
   cosmetic only.
5. **Timestamp column names — drift family (cosmetic).** Upstream
   `created_unix`/`updated_unix` vs ours `created_at`/`updated_at` on the
   SPEC-0001/0005-era tables, and `created`/`updated` on the actions
   family — ~30 tables. Nothing records the choice, and the codebase is
   internally inconsistent about it (SPEC-0018 §4.1 used `created_unix`
   for parity when it landed post-ADR). Names never cross the API (Drizzle
   property names are already camelCase; the JSON renderers name their own
   fields), so this is the lowest-stakes drift — FN-13 bundles it into a
   record-or-rename decision unit.
6. **`uid` → `user_id` renames — drift family (cosmetic).** `follow`,
   `star`, `issue_user`, `team_user`, `email_address` (5 tables) — batched
   with FN-13.
7. **NOT-NULL strictness inversion — drift class (386 columns), recommend
   record-not-migrate.** Upstream xorm leaves columns nullable unless the
   tag says `NOT NULL`; ours declares `notNull()` far more widely. Ours is
   the *stricter* shape and matches upstream's actual INSERT behavior
   (xorm writes every mapped field); relaxing our columns to match
   upstream's DDL would only weaken integrity. The ADR vocabulary has no
   "stricter-than-upstream" class, so honestly: drift by the letter,
   resolved by RECORDING (an ADR-0007 appendix note), not by DDL. The
   handful of inversions where OURS is the nullable side are itemized in
   §4 under their tables (`issue_pins.repo_id/issue_id`,
   `issue_subscriptions.created_unix/updated_unix`,
   `users.email/avatar_email`).

## 3. The census

### 3.1 Upstream table → ours (117 rows)

Verdict vocabulary is ADR-0007's: `aligned` / `platform-adapted` /
`intentional-recorded` / `drift` / `missing-table` / `extra-ours`.
Upstream cite = the struct definition (`gitea/models/...`, the registered
bean's shape); ours cite = the `export const ... = sqliteTable(`
declaration line in `apps/worker/src/db/schema.ts` (the SQL name sits on
the same or the following line). "blanket families" in a reason = §2's
classes only.

| upstream table | upstream cite | our counterpart | verdict | reason (with cite) |
|---|---|---|---|---|
| `protected_tag` | models/git/protected_tag.go:21 | schema.ts:3120 `protected_tags` | drift | allowlist_team_i_ds/allowlist_user_i_ds gonic renames |
| `package_blob_upload` | models/packages/package_blob_upload.go:24 | schema.ts:3837 `package_blob_uploads` | drift | hash_state_bytes missing (resumable-upload state); chunk_count extra |
| `package_cleanup_rule` | models/packages/package_cleanup_rule.go:25 | schema.ts:3788 `package_cleanup_rules` | aligned | blanket families only (id / timestamp-name / strictness) |
| `commit_status_summary` | models/git/commit_status_summary.go:17 | — | missing-table | no reader in worker (grep 0) |
| `commit_status` | models/git/commit_status.go:37 | schema.ts:1066 `commit_statuses` | drift | missing context_hash, index |
| `commit_status_index` | models/git/commit_status.go:330 | — | missing-table | no table; autoincrement id substitutes, documented TODO(SPEC-0005) (api/services/commit-status.ts:88-91,143-145) |
| `lfs_lock` | models/git/lfs_lock.go:21 | schema.ts:1281 `lfs_locks` | drift | ours-extra lower_path (schema.ts:1293, unrecorded case-fold lookup; FN-12 records it); `created` → `created_at` is the FN-13 §7.2 recorded timestamp-name family |
| `package_blob` | models/packages/package_blob.go:30 | schema.ts:3693 `package_blobs` | drift | hash_m_d5/sh_a1/sh_a256/sh_a512 gonic renames |
| `package` | models/packages/package.go:191 | schema.ts:3613 `packages` | aligned | blanket families only (id / timestamp-name / strictness) |
| `lfs_meta_object` | models/git/lfs.go:80 | schema.ts:1241 `lfs_objects` | intentional-recorded | lfs_objects state machine, bare keys; SPEC-0006 §3 (schema.ts:1241) |
| `protected_branch` | models/git/protected_branch.go:30 | schema.ts:2485 `protected_branches` | drift | branch_name → rule_name and config → rules renames |
| `package_property` | models/packages/package_property.go:31 | schema.ts:3757 `package_properties` | aligned | blanket families only (id / timestamp-name / strictness) |
| `package_file` | models/packages/package_file.go:34 | schema.ts:3724 `package_files` | aligned | blanket families only (id / timestamp-name / strictness) |
| `package_version` | models/packages/package_version.go:27 | schema.ts:3650 `package_versions` | aligned | blanket families only (id / timestamp-name / strictness) |
| `team` | models/organization/team.go:76 | schema.ts:2151 `teams` | intentional-recorded | units_map JSON substitutes team_unit rows (schema.ts:2130, api/routes/org-teams.ts:128,309; SPEC-0007) |
| `team_user` | models/organization/team_user.go:16 | schema.ts:2214 `team_members` | aligned | blanket families only (id / timestamp-name / strictness) |
| `team_repo` | models/organization/team_repo.go:17 | schema.ts:2248 `team_repo_access` | aligned | blanket families only (id / timestamp-name / strictness) |
| `team_unit` | models/organization/team_unit.go:15 | — | missing-table | function covered by teams.units_map JSON (schema.ts:2130, org-teams.ts:128) |
| `team_invite` | models/organization/team_invite.go:73 | — | missing-table | no table, no reader (org-teams.ts:608) |
| `org_user` | models/organization/org_user.go:26 | schema.ts:1377 `org_members` | intentional-recorded | role enum column (SPEC-0007 §3.3, schema.ts:1377) |
| `access` | models/perm/access/access.go:25 | — | missing-table | function covered by repo_collaborators.mode + team computation (SPEC-0007) |
| `deploy_key` | models/deploykey/deploykey.go:25 | schema.ts:2551 `deploy_keys` | aligned | blanket families only (id / timestamp-name / strictness) |
| `branch` | models/git/branch.go:106 | — | missing-table | live arm engine-derived from git; deleted arm ported as ours deleted_branches (schema.ts:4939) |
| `renamed_branch` | models/git/branch.go:293 | — | missing-table | no landed arm (ui/pages/raw-files.ts:95) |
| `email_hash` | models/avatars/avatar.go:33 | schema.ts:4805 `email_hash` | aligned | blanket families only (id / timestamp-name / strictness) |
| `notification` | models/activities/notification.go:52 | schema.ts:1809 `notification_states` | intentional-recorded | state-row reduction; SPEC email-outbound + user-notification-settings (schema.ts:1809); upstream payload columns not ported (residual) |
| `review_state` | models/pull/review_state.go:41 | schema.ts:4965 `review_state` | drift | missing updated_files (per-file viewed map; ours stores cursor only, api/ui pull-files.tsx:642) |
| `action` | models/activities/action.go:135 | schema.ts:3397 `action` | aligned | blanket families only (id / timestamp-name / strictness) |
| `pull_auto_merge` | models/pull/automerge.go:17 | schema.ts:4989 `pull_auto_merges` | drift | missing merged_commit_id; pull_id/message renames (value-space differs on pull_id); ours-extra sha |
| `action_schedule_spec` | models/actions/schedule_spec.go:19 | schema.ts:4519 `action_schedule_spec` | intentional-recorded | PENDING FM LANDING — column-faithful port; SPEC-0012 §4.1 conventions (schema.ts:4519) |
| `action_run_attempt` | models/actions/run_attempt.go:21 | schema.ts:4185 `action_run_attempts` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_schedule` | models/actions/schedule.go:21 | schema.ts:4476 `action_schedule` | intentional-recorded | PENDING FM LANDING — column-faithful port; SPEC-0012 §4.1 conventions (schema.ts:4476) |
| `action_runner` | models/actions/runner.go:40 | schema.ts:3944 `action_runners` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_tasks_version` | models/actions/tasks_version.go:18 | schema.ts:4335 `action_tasks_versions` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_task_output` | models/actions/task_output.go:16 | schema.ts:4310 `action_task_outputs` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_runner_token` | models/actions/runner_token.go:30 | schema.ts:4003 `action_runner_tokens` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_artifact` | models/actions/artifact.go:62 | schema.ts:4361 `action_artifacts` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_run` | models/actions/run.go:32 | schema.ts:4034 `action_runs` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_task_step` | models/actions/task_step.go:19 | schema.ts:4277 `action_task_steps` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_scoped_workflow_source` | models/actions/scoped_workflow.go:19 | schema.ts:2729 `action_scoped_workflow_source` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_run_job_summary` | models/actions/run_job_summary.go:36 | schema.ts:4407 `action_run_job_summaries` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_task` | models/actions/task.go:29 | schema.ts:4220 `action_tasks` | aligned | blanket families only (id / timestamp-name / strictness) |
| `action_variable` | models/actions/variable.go:31 | schema.ts:2666 `action_variables` | aligned | blanket families only (id / timestamp-name / strictness) |
| `project_board` | models/project/column.go:49 | schema.ts:2995 `project_columns` | drift | table renamed project_board → project_columns; default → is_default |
| `project_issue` | models/project/issue.go:15 | schema.ts:3038 `project_issues` | drift | project_board_id → project_column_id rename |
| `action_run_job` | models/actions/run_job.go:32 | schema.ts:4106 `action_run_jobs` | aligned | blanket families only (id / timestamp-name / strictness) |
| `project_workflow` | models/project/workflows.go:160 | schema.ts:3070 `project_workflows` | drift | workflow_event/filters/actions → event/filters/actions renames |
| `project` | models/project/project.go:85 | schema.ts:2936 `projects` | aligned | blanket families only (id / timestamp-name / strictness) |
| `hook_task` | models/webhook/hooktask.go:58 | schema.ts:1175 `webhook_deliveries` | intentional-recorded | Queues-based delivery redesign; SPEC-0005 §3.6 (schema.ts:1175) — §7.5 erratum: the old cite said §3.7, a section that does not exist |
| `webhook` | models/webhook/webhook.go:123 | schema.ts:1132 `webhooks` | aligned | blanket families only (id / timestamp-name / strictness) |
| `dbfs_meta` | models/dbfs/dbfs.go:48 | — | missing-table | platform: R2 replaces dbfs (schema.ts:3906,4439) |
| `dbfs_data` | models/dbfs/dbfs.go:57 | — | missing-table | platform: R2 replaces dbfs (schema.ts:3906,4439) |
| `secret` | models/secret/secret.go:39 | schema.ts:2624 `secrets` | aligned | blanket families only (id / timestamp-name / strictness) |
| `gpg_key` | models/asymkey/gpg_key.go:23 | schema.ts:2373 `gpg_keys` | drift | missing emails column (upstream serializes the address list) |
| `public_key` | models/asymkey/ssh_key.go:39 | schema.ts:2327 `public_keys` | aligned | blanket families only (id / timestamp-name / strictness) |
| `gpg_key_import` | models/asymkey/gpg_key_import.go:28 | — | missing-table | recorded unmodeled — raw armor not kept (schema.ts:2272-2273,2366) |
| `audit_event` | models/audit/audit_event.go:22 | schema.ts:3517 `audit_event` | drift | timestamp_unix → created_unix rename; enum-text family; scope_id TEXT (id-adjacent) |
| `issue_pin` | models/issues/issue_pin.go:17 | schema.ts:1093 `issue_pins` | drift | missing id, is_pull (issue_pin.go:19,22); repo_id ours-NULLable TEXT vs upstream NOT NULL int64 (issue_pin.go:20 vs schema.ts:1096 — §7.1); FN-10 carries; §7.1 erratum: pin_order/issue_id are NOT inversions (ours is the stricter side) |
| `reaction` | models/issues/reaction.go:62 | schema.ts:894 `reactions` | drift | missing original_author, original_author_id |
| `review` | models/issues/review.go:123 | schema.ts:2438 `pull_reviews` | drift | missing original_author, original_author_id |
| `issue_assignees` | models/issues/assignees.go:17 | schema.ts:1863 `issue_assignees` | aligned | blanket families only (id / timestamp-name / strictness) |
| `pull_request` | models/issues/pull.go:120 | schema.ts:680 `pull_requests` | drift | FN-1 status-enum swap IN FLIGHT (migration 0064 + schema.ts:588-596 re-map); still missing type, changed_protected_files; ours-extra head_sha (documented) |
| `milestone` | models/issues/milestone.go:47 | schema.ts:866 `milestones` | aligned | blanket families only (id / timestamp-name / strictness) |
| `stopwatch` | models/issues/stopwatch.go:20 | schema.ts:1940 `stopwatch` | aligned | blanket families only (id / timestamp-name / strictness) |
| `issue` | models/issues/issue.go:54 | schema.ts:610 `issues` | aligned | blanket families only (id / timestamp-name / strictness) |
| `comment` | models/issues/comment.go:273 | schema.ts:740 `comments` | drift | missing 8 mutation-metadata cols (patch_quoted, comment_meta_data, project_id, old_project_id, time_id, assignee_team_id, original_author, original_author_id) |
| `issue_content_history` | models/issues/content_history.go:20 | schema.ts:3455 `issue_content_history` | aligned | blanket families only (id / timestamp-name / strictness) |
| `tracked_time` | models/issues/tracked_time.go:22 | schema.ts:1913 `tracked_time` | drift | time → seconds column rename (unit kept seconds) |
| `issue_dependency` | models/issues/dependency.go:101 | schema.ts:1885 `issue_dependency` | drift | missing updated_unix |
| `issue_user` | models/issues/issue_user.go:15 | schema.ts:1034 `issue_user` | aligned | blanket families only (id / timestamp-name / strictness) |
| `issue_watch` | models/issues/issue_watch.go:17 | schema.ts:992 `issue_subscriptions` | drift | FN-13 §7.1: created_unix/updated_unix ours-NULLable vs upstream NOT NULL (issue_watch.go:20-21 vs schema.ts:999-1000) — the ours-looser arm, NOT covered by the strictness record; recommended carrier FN-12; table name + the rest are the FN-13 §7.2/§7.5 recorded families |
| `task` | models/admin/task.go:26 | — | missing-table | platform: admin task queue rides Cloudflare Queues/REPO_TASKS (SPEC-0020) |
| `label` | models/issues/label.go:81 | schema.ts:812 `labels` | aligned | blanket families only (id / timestamp-name / strictness) |
| `issue_label` | models/issues/issue_label.go:19 | schema.ts:840 `issue_labels` | drift | missing id pk (composite PK used) |
| `app_state` | models/system/appstate.go:17 | — | missing-table | no reader; cron bookkeeping lives in ours cron_state (SPEC-0020) |
| `notice` | models/system/notice.go:29 | schema.ts:3875 `system_notices` | intentional-recorded | system_notices plural + int type recorded; SPEC-0018 §4.1 (schema.ts:3875) |
| `system_setting` | models/system/setting.go:20 | — | missing-table | platform: no runtime-writable settings store — config = wrangler vars; SPEC-0018 §1-2 |
| `session` | models/auth/session.go:15 | schema.ts:1977 `sessions` | intentional-recorded | D1 session redesign (sha256 at rest, rotation); SPEC-0010 §data-model (schema.ts:1977) |
| `webauthn_credential` | models/auth/webauthn.go:45 | schema.ts:5089 `webauthn_credentials` | intentional-recorded | transports JSON column recorded; SPEC-0022 (schema.ts:5089) |
| `login_source` | models/auth/source.go:110 | schema.ts:4841 `login_source` | intentional-recorded | cfg JSON typed record, OAuth2-only v1; external-auth-sources §4 (schema.ts:4841) |
| `access_token` | models/auth/access_token.go:20 | schema.ts:545 `personal_access_tokens` | intentional-recorded | PAT redesign: prefix/sha256/scopes/expires; SPEC-0002 §2.7+§3 (schema.ts:545) |
| `auth_token` | models/auth/auth_token.go:18 | — | missing-table | function covered by sessions sha256_digest/rotation columns (SPEC-0010) |
| `two_factor` | models/auth/twofactor.go:52 | schema.ts:5019 `two_factor` | intentional-recorded | last_used_passcode_period replay-guard divergence; SPEC-0022 (schema.ts:5019) |
| `oauth2_application` | models/auth/oauth2.go:39 | schema.ts:3168 `oauth2_application` | drift | redirect_ur_is → redirect_uris gonic-quirk rename |
| `oauth2_authorization_code` | models/auth/oauth2.go:403 | schema.ts:3253 `oauth2_authorization_code` | aligned | blanket families only (id / timestamp-name / strictness) |
| `oauth2_grant` | models/auth/oauth2.go:504 | schema.ts:3215 `oauth2_grant` | aligned | blanket families only (id / timestamp-name / strictness) |
| `mirror` | models/repo/mirror.go:23 | schema.ts:1720 `repo_mirrors` | intentional-recorded | sync-state/credentials restructure; SPEC-0009 §3 (schema.ts:1720) |
| `repo_archiver` | models/repo/archiver.go:65 | — | missing-table | archives built on demand and streamed; SPEC-0004 §2.4 (api/services/archive.ts:1-8) |
| `collaboration` | models/repo/collaboration.go:20 | schema.ts:1500 `repo_collaborators` | drift | missing id (FN-12); created_unix/updated_unix are PRESENT as created_at/updated_at (FN-13 §7.2 recorded family — the old reason miscounted them missing); mode is the TEXT-enum blanket (§2.3) |
| `watch` | models/repo/watch.go:39 | schema.ts:1475 `repo_watchers` | aligned | blanket families only (id / timestamp-name / strictness) |
| `release` | models/repo/release.go:67 | schema.ts:930 `releases` | drift | missing original_author, original_author_id |
| `language_stat` | models/repo/language_stats.go:19 | — | missing-table | on-demand extension-sum reduction; SPEC-0004 divergence note (api/services/languages.ts:1-15) |
| `repo_unit` | models/repo/repo_unit.go:42 | schema.ts:341 `repo_units` | drift | missing id, created_unix, everyone_access_mode |
| `repo_redirect` | models/repo/redirect.go:38 | schema.ts:277 `repo_redirects` | intentional-recorded | owner_namespace routing column added; SPEC-0003 (schema.ts:277) |
| `repo_indexer_status` | models/repo/repo_indexer.go:27 | — | missing-table | indexer-class store DEFERRED with reopen triggers; SPEC-0019 §3/§4.2 |
| `star` | models/repo/star.go:17 | schema.ts:1584 `stars` | aligned | blanket families only (id / timestamp-name / strictness) |
| `push_mirror` | models/repo/pushmirror.go:20 | schema.ts:2842 `push_mirrors` | intentional-recorded | sync-state/credentials restructure; SPEC push-mirror-outbound (schema.ts:2842) |
| `repo_transfer` | models/repo/transfer.go:64 | schema.ts:305 `repo_transfer` | drift | team_i_ds gonic rename; recipient_id → new_owner_id; recipient_access_granted missing |
| `repo_license` | models/repo/license.go:17 | schema.ts:3344 `repo_license` | aligned | blanket families only (id / timestamp-name / strictness) |
| `upload` | models/repo/upload.go:43 | schema.ts:2095 `issue_attachments` | intentional-recorded | merged into issue_attachments (pre-confirm staging absorbed); SPEC-0005 (schema.ts:2095) |
| `topic` | models/repo/topic.go:28 | — | missing-table | names stored directly in repo_topics (schema.ts:1438); SPEC-0004 §2.4 |
| `repo_topic` | models/repo/topic.go:37 | schema.ts:1438 `repo_topics` | intentional-recorded | topic name in row (no topics join table); SPEC-0004 §2.4 topics ops (schema.ts:1438) |
| `repository` | models/repo/repo.go:153 | schema.ts:29 `repositories` | intentional-recorded | core shape per SPEC-0001 §4 (schema.ts:29); RESIDUAL DRIFT flagged — see §4 row repositories |
| `follow` | models/user/follow.go:16 | schema.ts:1550 `follows` | aligned | blanket families only (id / timestamp-name / strictness) |
| `attachment` | models/repo/attachment.go:26 | schema.ts:2095 `issue_attachments`, schema.ts:965 `release_assets` | intentional-recorded | split into issue_attachments + release_assets; SPEC-0005 §3.2/§3.x (schema.ts:2095,965) |
| `email_address` | models/user/email_address.go:83 | schema.ts:2291 `email_addresses` | aligned | blanket families only (id / timestamp-name / strictness) |
| `user_open_id` | models/user/openid.go:18 | — | missing-table | no reader in worker (grep 0) |
| `user_blocking` | models/user/block.go:24 | schema.ts:2784 `user_blocking` | aligned | blanket families only (id / timestamp-name / strictness) |
| `external_login_user` | models/user/external_login_user.go:47 | schema.ts:4891 `external_login_user` | intentional-recorded | raw_data dropped, tokens written empty; external-auth-sources §7.6/§7.8 (schema.ts:4891) |
| `user_redirect` | models/user/redirect.go:37 | schema.ts:1407 `user_redirects` | aligned | blanket families only (id / timestamp-name / strictness) |
| `badge` | models/user/badge.go:17 | schema.ts:3296 `badge` | aligned | blanket families only (id / timestamp-name / strictness) |
| `user_badge` | models/user/badge.go:25 | schema.ts:3309 `user_badge` | aligned | blanket families only (id / timestamp-name / strictness) |
| `user` | models/user/user.go:95 | schema.ts:429 `users` | intentional-recorded | account-security internals dropped; SPEC-0002 §3 (users reduced "to what cf-gitea needs today", schema.ts:429-433); email/avatar_email NULLable vs upstream NOT NULL now recorded via SPEC-0002 §4.6 item 16 (FN-13 §7.1) |
| `user_setting` | models/user/setting.go:23 | schema.ts:1673 `user_settings_kv` | aligned | faithful KV port; profile prefs live in ours-extra user_settings (user-notification-settings.md) |
| `action_run_index` | models/actions/run.go:369 | — | missing-table | function covered by repo_counters.run_index (schema.ts:417) |
| `issue_index` | models/issues/issue.go:119 | — | missing-table | function covered by repo_counters.issue_index (schema.ts:417; SPEC-0012) |
| `action_run_attempt_job_id_index` | models/actions/run_job.go:141 | — | missing-table | inline 1..N allocation at trigger time (services/actions/trigger.ts:2593-2594,2733) |

### 3.2 Ours-extras (12 tables, no upstream counterpart)

| our table | cite | verdict | reason |
|---|---|---|---|
| `repo_counters` | schema.ts:417 | extra-ours | consolidated per-repo number allocators (`issue_index`, `run_index`) — the platform-idiomatic merge of upstream's per-resource index tables; SPEC-0012. Known ours-extra per the audit brief; comment-verified. |
| `auth_failures` | schema.ts:575 | extra-ours | brute-force throttle ledger; SPEC-0002. |
| `repo_imports` | schema.ts:1322 | extra-ours | import/migration task rows; SPEC-0003/SPEC-0009. |
| `repo_settings` | schema.ts:1523 | extra-ours | per-repo settings row; SPEC-0004. |
| `user_settings` | schema.ts:1611 | extra-ours | columnar profile-prefs side store (theme/language/hide_email/hide_activity/diff_view_style/email_notifications_preference); user-notification-settings.md + SPEC-0020. Upstream's `user_setting` KV is separately ported 1:1 as `user_settings_kv`. |
| `action_log_chunks` | schema.ts:4446 | extra-ours | hot log bytes per task — the `dbfs` analog on R2/D1; SPEC-0012 §4.3 (schema.ts:3906,4439). |
| `system_keystore` | schema.ts:4593 | extra-ours | instance keystore (JWT/OIDC material); SPEC-0012 §4.4 + SPEC-0018 §1 (schema.ts:4550-4562) — upstream keeps these in app.ini/AppData files, which the substrate lacks. |
| `cron_state` | schema.ts:4636 | extra-ours | cron tick bookkeeping; SPEC-0020. |
| `email_outbox` | schema.ts:4664 | extra-ours | outbound mail rows; SPEC email-outbound. |
| `email_inbound` | schema.ts:4722 | extra-ours | inbound mail rows; SPEC email-inbound. |
| `deleted_branches` | schema.ts:4939 | extra-ours | the deleted arm of upstream's `branch` table (restore source: tip sha at delete time, actor, timestamp) split into its own table; the live arm is engine-derived. No standalone SPEC cite found — fold the record into the next schema-touching SPEC. |
| `federation_followers` | schema.ts:5160 | extra-ours | ActivityPub follower store; SPEC federation (the ADR-0007 §"S-1 unlocked" arm). |

Arithmetic: 95 upstream tables paired (one pair, `attachment`, splits into
two of ours; the `upload` pair shares `issue_attachments` with it) + 22
missing = 117 upstream. On our side: 95 distinct tables covered by the
pairs (the split adds `release_assets` beyond the 94 one-to-one names) +
12 extras = 107 definitions.

### 3.3 Missing tables — the no-reader arm (port-when-read)

22 upstream tables have no counterpart. They split three ways:

- **Function covered elsewhere (no port needed):** `issue_index` +
  `action_run_index` (`repo_counters.issue_index`/`.run_index`,
  schema.ts:417), `action_run_attempt_job_id_index` (inline 1..N
  allocation, `services/actions/trigger.ts:2593-2594,2733`),
  `commit_status_index` (autoincrement id substitute, documented
  TODO(SPEC-0005), `api/services/commit-status.ts:88-91,143-145`),
  `auth_token` (sessions carry `sha256_digest` + rotation columns;
  SPEC-0010), `access` (repo_collaborators.mode + team computation;
  SPEC-0007), `team_unit` (`teams.units_map` JSON, schema.ts:2130 +
  `api/routes/org-teams.ts:128,309`), `topic` (names stored directly in
  `repo_topics`, schema.ts:1438; SPEC-0004 §2.4), `task` (Queues/REPO_TASKS
  replace the admin task queue), `branch` (live arm engine-derived; deleted
  arm ported as ours `deleted_branches`), `app_state` (no landed consumer;
  cron bookkeeping lives in ours `cron_state`).
- **Platform-adapted (the platform genuinely cannot / need not):**
  `dbfs_meta` + `dbfs_data` (R2 replaces dbfs; schema.ts:3906,4439),
  `system_setting` (SPEC-0018 §1-2: no app.ini, no runtime-writable
  settings store — config is wrangler vars), `repo_archiver` (archives
  built on demand and streamed; SPEC-0004 §2.4, `api/services/archive.ts`),
  `language_stat` (on-demand extension-sum reduction; SPEC-0004 divergence
  note, `api/services/languages.ts:1-15`), `repo_indexer_status`
  (indexer-class store DEFERRED with recorded reopen triggers; SPEC-0019).
- **NO reader in our worker yet — port-when-read arm:** `user_open_id`
  (grep 0), `team_invite` (`api/routes/org-teams.ts:608` — no table, no
  reader), `renamed_branch` (`ui/pages/raw-files.ts:95` — no landed arm),
  `commit_status_summary` (grep 0), `gpg_key_import` (recorded unmodeled,
  schema.ts:2272-2273,2366 — armor not kept, a deliberate reduction rather
  than a pending reader). Queue each as its own migration + SPEC only when
  a reader needs it (the ADR-0007 grant applies when that day comes).

### 3.4 FM in-flight note (pending landing)

`schema.ts` currently carries sibling unit FM's `action_schedule`
(schema.ts:4476) + `action_schedule_spec` (schema.ts:4519) — singular
names per upstream, marked here "pending FM landing". Verified against
`gitea/models/actions/schedule.go:21` (`ActionSchedule`, 14 columns) and
`schedule_spec.go:19` (`ActionScheduleSpec`, 8 columns): **column-name
faithful, all 22 columns present, none missing, none extra.** The port's
divergences are the recorded kind: `repo_id` TEXT (id family),
`content` LONGBLOB→TEXT (workflow source is UTF-8 text), `next`/`prev`
nullable with NULL = never (upstream's zero-TimeStamp sentinel — the
comment at schema.ts:4468-4474 cites the §4.1 census conventions), blanket
NOT-NULL strictness, and TEXT enum `event`. Verdict as landed:
intentional-recorded (SPEC-0012 §4.1). If FM's final landing shifts these
lines, only the schema.ts line cites in this file go stale — the column
census holds.

## 4. Column-level drift (the drifted tables)

27 subsections: the 26 drift-class tables + `repositories` (verdict
intentional-recorded with a flagged residual). Within each, blanket-family
renames (created_at/updated_at, uid→user_id) are excluded; explicit RENAME
lines are table-specific name-only divergences; MISSING/OURS-EXTRA/TYPE
lines are structural. Both-side cites on every line.

### `comment` → `comments` schema.ts:740

upstream: models/issues/comment.go (struct `Comment`)

- MISSING `assignee_team_id` (integer NOT NULL, DEFAULT 0) — upstream models/issues/comment.go:308 (`AssigneeTeamID`); no ours counterpart
- MISSING `comment_meta_data` (text(json)) — upstream models/issues/comment.go:361 (`CommentMetaData`); no ours counterpart
- MISSING `old_project_id` (integer) — upstream models/issues/comment.go:292 (`OldProjectID`); no ours counterpart
- MISSING `original_author` (text) — upstream models/issues/comment.go:281 (`OriginalAuthor`); no ours counterpart
- MISSING `original_author_id` (integer) — upstream models/issues/comment.go:282 (`OriginalAuthorID`); no ours counterpart
- MISSING `patch_quoted` (text) — upstream models/issues/comment.go:331 (`PatchQuoted`); no ours counterpart
- MISSING `project_id` (integer) — upstream models/issues/comment.go:293 (`ProjectID`); no ours counterpart
- MISSING `time_id` (integer) — upstream models/issues/comment.go:302 (`TimeID`); no ours counterpart
- OURS-EXTRA `patch` — schema.ts:763 (`comments.patch`)
- TYPE `removed_assignee`: upstream boolean (models/issues/comment.go:306) vs ours integer (schema.ts:752 (`comments`))

### `commit_status` → `commit_statuses` schema.ts:1066

upstream: models/git/commit_status.go (struct `CommitStatus`)

- MISSING `context_hash` (text(varchar64)) — upstream models/git/commit_status.go:51 (`ContextHash`); no ours counterpart
- MISSING `index` (integer) — upstream models/git/commit_status.go:42 (`Index`); no ours counterpart

### `gpg_key` → `gpg_keys` schema.ts:2373

upstream: models/asymkey/gpg_key.go (struct `GPGKey`)

- MISSING `emails` (text(json)) — upstream models/asymkey/gpg_key.go:34 (`Emails`); no ours counterpart

### `issue_label` → `issue_labels` schema.ts:840

upstream: models/issues/issue_label.go (struct `IssueLabel`)

- MISSING `id` (integer) — upstream models/issues/issue_label.go:21 (`ID`); no ours counterpart

### `issue_pin` → `issue_pins` schema.ts:1093

upstream: models/issues/issue_pin.go (struct `IssuePin`)

- MISSING `id` (integer) — upstream models/issues/issue_pin.go:19 (`ID`); no ours counterpart
- MISSING `is_pull` (boolean NOT NULL) — upstream models/issues/issue_pin.go:22 (`IsPull`); no ours counterpart

### `issue_dependency` → `issue_dependency` schema.ts:1885

upstream: models/issues/dependency.go (struct `IssueDependency`)

- MISSING `updated_unix` (integer) — upstream models/issues/dependency.go:108 (`UpdatedUnix`); no ours counterpart

### `tracked_time` → `tracked_time` schema.ts:1913

upstream: models/issues/tracked_time.go (struct `TrackedTime`)

- RENAME `time` → `seconds` (ours `tracked_time`; schema.ts:1920) — rename; unit stays seconds upstream API json "time" is seconds too (modules/structs)

### `review` → `pull_reviews` schema.ts:2438

upstream: models/issues/review.go (struct `Review`)

- MISSING `original_author` (text) — upstream models/issues/review.go:131 (`OriginalAuthor`); no ours counterpart
- MISSING `original_author_id` (integer) — upstream models/issues/review.go:132 (`OriginalAuthorID`); no ours counterpart

### `reaction` → `reactions` schema.ts:894

upstream: models/issues/reaction.go (struct `Reaction`)

- MISSING `original_author` (text NOT NULL) — upstream models/issues/reaction.go:71 (`OriginalAuthor`); no ours counterpart
- MISSING `original_author_id` (integer NOT NULL) — upstream models/issues/reaction.go:70 (`OriginalAuthorID`); no ours counterpart

### `release` → `releases` schema.ts:930

upstream: models/repo/release.go (struct `Release`)

- MISSING `original_author` (text) — upstream models/repo/release.go:75 (`OriginalAuthor`); no ours counterpart
- MISSING `original_author_id` (integer) — upstream models/repo/release.go:76 (`OriginalAuthorID`); no ours counterpart

### `review_state` → `review_state` schema.ts:4965

upstream: models/pull/review_state.go (struct `ReviewState`)

- RENAME `pull_id` → `issue_id` (ours `review_state`; schema.ts:4971) — NAME + VALUE-SPACE: upstream pull_id = pull_request.id (gitdiff.go:1513 passes pull.ID); ours issue_id = issues.id (1:1 rows, but the stored id space differs)
- MISSING `updated_files` (text(json) NOT NULL) — upstream models/pull/review_state.go:47 (`UpdatedFiles`); no ours counterpart

### `pull_auto_merge` → `pull_auto_merges` schema.ts:4989

upstream: models/pull/automerge.go (struct `AutoMerge`)

- RENAME `message` → `merge_message` (ours `pull_auto_merges`; schema.ts:5004) — rename-only divergence (name, not semantics)
- RENAME `pull_id` → `issue_id` (ours `pull_auto_merges`; schema.ts:4994) — NAME + VALUE-SPACE: upstream pull_id = pull_request.id (gitdiff.go:1513 passes pull.ID); ours issue_id = issues.id (1:1 rows, but the stored id space differs)
- MISSING `merged_commit_id` (text(varchar64)) — upstream models/pull/automerge.go:27 (`MergedCommitID`); no ours counterpart
- OURS-EXTRA `sha` — schema.ts:4998 (`pull_auto_merges.sha`)

### `oauth2_application` → `oauth2_application` schema.ts:3168

upstream: models/auth/oauth2.go (struct `OAuth2Application`)

- RENAME `redirect_ur_is` → `redirect_uris` (ours `oauth2_application`; schema.ts:3184) — rename-only divergence (name, not semantics)

### `protected_branch` → `protected_branches` schema.ts:2485

upstream: models/git/protected_branch.go (struct `ProtectedBranch`)

- RENAME `branch_name` → `rule_name` (ours `protected_branches`; schema.ts:2495) — rename-only divergence (name, not semantics)
- RENAME `config` → `rules` (ours `protected_branches`; schema.ts:2501) — rename-only divergence (name, not semantics)

### `protected_tag` → `protected_tags` schema.ts:3120

upstream: models/git/protected_tag.go (struct `ProtectedTag`)

- RENAME `allowlist_team_i_ds` → `allowlist_team_ids` (ours `protected_tags`; schema.ts:3133) — rename-only divergence (name, not semantics)
- RENAME `allowlist_user_i_ds` → `allowlist_user_ids` (ours `protected_tags`; schema.ts:3131) — rename-only divergence (name, not semantics)

### `package_blob` → `package_blobs` schema.ts:3693

upstream: models/packages/package_blob.go (struct `PackageBlob`)

- RENAME `hash_m_d5` → `hash_md5` (ours `package_blobs`; schema.ts:3700) — rename-only divergence (name, not semantics)
- RENAME `hash_sh_a1` → `hash_sha1` (ours `package_blobs`; schema.ts:3701) — rename-only divergence (name, not semantics)
- RENAME `hash_sh_a256` → `hash_sha256` (ours `package_blobs`; schema.ts:3703) — rename-only divergence (name, not semantics)
- RENAME `hash_sh_a512` → `hash_sha512` (ours `package_blobs`; schema.ts:3704) — rename-only divergence (name, not semantics)

### `package_blob_upload` → `package_blob_uploads` schema.ts:3837

upstream: models/packages/package_blob_upload.go (struct `PackageBlobUpload`)

- MISSING `hash_state_bytes` (blob) — upstream models/packages/package_blob_upload.go:28 (`HashStateBytes`); no ours counterpart
- OURS-EXTRA `chunk_count` — schema.ts:3845 (`package_blob_uploads.chunkCount`)

### `project_board` → `project_columns` schema.ts:2995

upstream: models/project/column.go (struct `Column`)

- RENAME `default` → `is_default` (ours `project_columns`; schema.ts:3004) — rename-only divergence (name, not semantics)

### `project_issue` → `project_issues` schema.ts:3038

upstream: models/project/issue.go (struct `ProjectIssue`)

- RENAME `project_board_id` → `project_column_id` (ours `project_issues`; schema.ts:3048) — rename-only divergence (name, not semantics)

### `project_workflow` → `project_workflows` schema.ts:3070

upstream: models/project/workflows.go (struct `Workflow`)

- RENAME `workflow_actions` → `actions` (ours `project_workflows`; schema.ts:3084) — rename-only divergence (name, not semantics)
- RENAME `workflow_event` → `event` (ours `project_workflows`; schema.ts:3078) — rename-only divergence (name, not semantics)
- RENAME `workflow_filters` → `filters` (ours `project_workflows`; schema.ts:3081) — rename-only divergence (name, not semantics)

### `repo_transfer` → `repo_transfer` schema.ts:305

upstream: models/repo/transfer.go (struct `RepoTransfer`)

- RENAME `created_unix` → `created_at` (ours `repo_transfer`; schema.ts:314) — rename-only divergence (name, not semantics)
- RENAME `recipient_id` → `new_owner_id` (ours `repo_transfer`; schema.ts:313) — rename-only divergence (name, not semantics)
- RENAME `team_i_ds` → `team_ids` (ours `repo_transfer`; schema.ts:332) — rename-only divergence (name, not semantics)
- MISSING `recipient_access_granted` (boolean NOT NULL, DEFAULT false) — upstream models/repo/transfer.go:76 (`RecipientAccessGranted`); no ours counterpart
- MISSING `updated_unix` (integer NOT NULL) — upstream models/repo/transfer.go:79 (`UpdatedUnix`); no ours counterpart

### `repo_unit` → `repo_units` schema.ts:341

upstream: models/repo/repo_unit.go (struct `RepoUnit`)

- MISSING `created_unix` (integer) — upstream models/repo/repo_unit.go:48 (`CreatedUnix`); no ours counterpart
- MISSING `everyone_access_mode` (integer NOT NULL, DEFAULT 0) — upstream models/repo/repo_unit.go:50 (`EveryoneAccessMode`); no ours counterpart
- MISSING `id` (integer) — upstream models/repo/repo_unit.go:44 (`ID`); no ours counterpart
- TYPE `anonymous_access_mode`: upstream integer (models/repo/repo_unit.go:49) vs ours text (schema.ts:369 (`repo_units`))
- TYPE `type`: upstream integer (models/repo/repo_unit.go:46) vs ours text (schema.ts:365 (`repo_units`))

### `collaboration` → `repo_collaborators` schema.ts:1500

upstream: models/repo/collaboration.go (struct `Collaboration`)

- RENAME `created_unix` → `created_at` (ours `repo_collaborators`; schema.ts:1506) — rename-only divergence (name, not semantics)
- RENAME `updated_unix` → `updated_at` (ours `repo_collaborators`; schema.ts:1507) — rename-only divergence (name, not semantics)
- MISSING `id` (integer) — upstream models/repo/collaboration.go:22 (`ID`); no ours counterpart
- TYPE `mode`: upstream integer (models/repo/collaboration.go:25) vs ours text (schema.ts:1505 (`repo_collaborators`))

### `audit_event` → `audit_event` schema.ts:3517

upstream: models/audit/audit_event.go (struct `Event`)

- RENAME `timestamp_unix` → `created_unix` (ours `audit_event`; schema.ts:3552) — rename-only divergence (name, not semantics)
- TYPE `action`: upstream integer (models/audit/audit_event.go:25) vs ours text (schema.ts:3524 (`audit_event`))
- TYPE `origin`: upstream integer (models/audit/audit_event.go:34) vs ours text (schema.ts:3545 (`audit_event`))
- TYPE `scope_type`: upstream integer (models/audit/audit_event.go:32) vs ours text (schema.ts:3536 (`audit_event`))

### `pull_request` → `pull_requests` schema.ts:680

upstream: models/issues/pull.go (struct `PullRequest`)

- MISSING `changed_protected_files` (text(json)) — upstream models/issues/pull.go:129 (`ChangedProtectedFiles`); no ours counterpart
- MISSING `type` (integer) — upstream models/issues/pull.go:123 (`Type`); no ours counterpart
- OURS-EXTRA `head_sha` — schema.ts:699 (`pull_requests.headSha`)

### `lfs_lock` → `lfs_locks` schema.ts:1281

upstream: models/git/lfs_lock.go (struct `LFSLock`)

- RENAME `created` → `created_at` (ours `lfs_locks`; schema.ts:1294) — rename-only divergence (name, not semantics)
- OURS-EXTRA `lower_path` — schema.ts:1293 (`lfs_locks.lowerPath`)

### `repository` → `repositories` schema.ts:29

upstream: models/repo/repo.go (struct `Repository`) — table verdict intentional-recorded (SPEC-0001 §4 core shape); the following upstream columns have NO counterpart and NO SPEC-0001 record — RESIDUAL DRIFT, additive NULLable ports unless noted

- MISSING `archived_unix` (integer, DEFAULT 0) — upstream models/repo/repo.go:221 (`ArchivedUnix`)
- MISSING `avatar` (text(varchar64)) — upstream models/repo/repo.go:217 (`Avatar`)
- MISSING `created_unix` (integer) — upstream models/repo/repo.go:219 (`CreatedUnix`)
- MISSING `default_wiki_branch` (text) — upstream models/repo/repo.go:166 (`DefaultWikiBranch`)
- MISSING `description` (text) — upstream models/repo/repo.go:161 (`Description`)
- MISSING `fork_id` (integer) — upstream models/repo/repo.go:200 (`ForkID`)
- MISSING `git_size` (integer NOT NULL, DEFAULT 0) — upstream models/repo/repo.go:205 (`GitSize`)
- MISSING `is_fork` (boolean NOT NULL, DEFAULT false) — upstream models/repo/repo.go:199 (`IsFork`)
- MISSING `is_fsck_enabled` (boolean NOT NULL, DEFAULT true) — upstream models/repo/repo.go:209 (`IsFsckEnabled`)
- MISSING `is_private` (boolean) — upstream models/repo/repo.go:187 (`IsPrivate`)
- MISSING `lfs_size` (integer NOT NULL, DEFAULT 0) — upstream models/repo/repo.go:206 (`LFSSize`)
- MISSING `lower_name` (text NOT NULL) — upstream models/repo/repo.go:159 (`LowerName`)
- MISSING `name` (text NOT NULL) — upstream models/repo/repo.go:160 (`Name`)
- MISSING `num_action_runs` (integer NOT NULL, DEFAULT 0) — upstream models/repo/repo.go:183 (`NumActionRuns`)
- MISSING `num_closed_action_runs` (integer NOT NULL, DEFAULT 0) — upstream models/repo/repo.go:184 (`NumClosedActionRuns`)
- MISSING `num_closed_projects` (integer NOT NULL, DEFAULT 0) — upstream models/repo/repo.go:181 (`NumClosedProjects`)
- MISSING `num_projects` (integer NOT NULL, DEFAULT 0) — upstream models/repo/repo.go:180 (`NumProjects`)
- MISSING `object_format_name` (text(varchar6) NOT NULL, DEFAULT sha1) — upstream models/repo/repo.go:212 (`ObjectFormatName`)
- MISSING `original_service_type` (integer) — upstream models/repo/repo.go:163 (`OriginalServiceType`)
- MISSING `owner_name` (text) — upstream models/repo/repo.go:157 (`OwnerName`)
- MISSING `size` (integer NOT NULL, DEFAULT 0) — upstream models/repo/repo.go:204 (`Size`)
- MISSING `template_id` (integer) — upstream models/repo/repo.go:203 (`TemplateID`)
- MISSING `topics` (text(json)) — upstream models/repo/repo.go:211 (`Topics`)
- MISSING `trust_model` (integer) — upstream models/repo/repo.go:214 (`TrustModel`)
- MISSING `updated_unix` (integer) — upstream models/repo/repo.go:220 (`UpdatedUnix`)
- MISSING `website` (text(varchar2048)) — upstream models/repo/repo.go:162 (`Website`)
- OURS-EXTRA `backend` — schema.ts (see repositories block)
- OURS-EXTRA `created_at` — schema.ts (see repositories block)
- OURS-EXTRA `fork_parent` — schema.ts (see repositories block)
- OURS-EXTRA `owner_namespace` — schema.ts (see repositories block)
- OURS-EXTRA `refs_version` — schema.ts (see repositories block)
- OURS-EXTRA `size_kb` — schema.ts (see repositories block)
- OURS-EXTRA `slug` — schema.ts (see repositories block)
- OURS-EXTRA `storage_key` — schema.ts (see repositories block)
- OURS-EXTRA `updated_at` — schema.ts (see repositories block)
- OURS-EXTRA `visibility` — schema.ts (see repositories block)
- TYPE `close_issues_via_commit_in_any_branch`: upstream boolean (models/repo/repo.go:210) vs ours integer (schema.ts)
- TYPE `status`: upstream integer (models/repo/repo.go:192) vs ours text (schema.ts)
- DEFAULT `status`: upstream `0` (models/repo/repo.go:192) vs ours `"ready"`

## 5. The numbered backlog (FN-1..FN-14)

Ordering: API-visible / behavior-carrying first; cosmetic renames and
records last. Every unit lands as its own generated migration + its own
SPEC record (ADR-0007's grant authorizes the class; SPEC-first still
applies).

- **FN-1 (FIXED as briefed): pull_requests.status enum order — a
  stored-data swap, not DDL.** Upstream iota
  (`gitea/models/issues/pull.go:100-107`) is Conflict=0, Checking=1,
  Mergeable=2, ManuallyMerged=3, Error=4, Empty=5, Ancestor=6; ours at
  audit-start (schema.ts enum object, comment at :586-587) swapped 2↔3 —
  `ManuallyMerged: 2, Mergeable: 3`. **STATUS: IN FLIGHT as this audit
  closed** — the sibling unit's fix is in the worktree: the enum object at
  schema.ts:588-596 now carries upstream's order verbatim (comment cites
  :100-107), and the stored-row remap landed as migration
  `0064_pr-status-upstream-alignment.sql` (single-statement
  `UPDATE pull_requests SET status = CASE status WHEN 2 THEN 3 WHEN 3 THEN
  2 ELSE status END` — statuses are engine-recomputed, and iota values
  0/1/4/5/6 are position-stable, so the swap is safe). This audit VERIFIED
  the worktree fix against upstream's iota: exact match. Rows already
  written under the old lattice are what make this a data migration even
  though no column changes shape.
- **FN-3: review_state.updated_files — the per-file viewed map.** Upstream
  stores the whole (path → viewed-state) map per (user, pull)
  (`models/pull/review_state.go:47`, LONGTEXT JSON NOT NULL; rendered by
  `pull.go:853 filesViewedState = reviewState.UpdatedFiles`); ours landed a
  REDUCTION — one sha cursor per (user, issue), the whole-PR mark
  (`schema.ts:4965-4983`; `ui/pages/pull-files.tsx:170,642` "the landed
  review_state reduction"). API/UI-visible: upstream's per-file viewed
  checkboxes degrade to a whole-PR toggle on ours. Port: add
  `updated_files` TEXT (JSON), write the map in
  `updateViewedFilesFromWeb`, keep the cursor for the cheap read. Rides
  the `pull_id` value-space note (§4 review_state) — migrating the key to
  pull_request.id is optional if recorded; issues.id works while the rows
  stay 1:1.
- **FN-2: comments mutation-metadata completion (8 columns).** Missing:
  `patch_quoted` (comment.go:331), `comment_meta_data` (comment.go:361),
  `project_id`/`old_project_id` (project-move comments, comment.go:292-293),
  `time_id` (time-tracking comments, comment.go:302), `assignee_team_id`
  (team review requests, comment.go:308), `original_author`/`original_author_id`
  (comment.go:281-282). Additive NULLable/DEFAULT-0 ports; unlocks the
  comment-type families ours renders as gaps.
- **FN-4: repositories upstream-column completion (26 columns).** The
  §4 repositories residual: identity denormalization (`name`, `lower_name`,
  `owner_name`), sizes (`size`, `git_size`, `lfs_size` — ours `size_kb`
  covers one), counters (`num_projects`/`num_closed_projects`,
  `num_action_runs`/`num_closed_action_runs`), `topics` (upstream's
  denormalized copy; ours reads repo_topics), `object_format_name`,
  `default_wiki_branch`, `original_service_type`, `trust_model`,
  `template_id`, `description`, `website`, `avatar`, `archived_unix`,
  `is_fsck_enabled`, `is_private`/`is_fork`/`fork_id` (ours folds these
  into `visibility`/`fork_parent` — record-or-add), plus the
  `created_unix`/`updated_unix` arm. Additive NULLable/DEFAULT-0 ports;
  several feed API fields (`description`, `website`, `avatar`) that ours
  renders empty today.
- **FN-5: the gonic-quirk + project rename batch (one migration).** All
  name-only renames to upstream's literal DDL: `redirect_uris`→
  `redirect_ur_is` (oauth2.go:52), `team_ids`→`team_i_ds` (transfer.go:73),
  `allowlist_team_ids`/`allowlist_user_ids`→`..._i_ds` (protected_tag.go:28-29),
  package_blobs `hash_md5`→`hash_m_d5`, `hash_sha1`→`hash_sh_a1`,
  `hash_sha256`→`hash_sh_a256`, `hash_sha512`→`hash_sh_a512`
  (package_blob.go:34-37), `protected_branches.rule_name`→`branch_name` +
  `rules`→`config` (protected_branch.go:35,39 — note upstream's field is
  RuleName with an explicit `'branch_name'` tag),
  `project_columns`→`project_board` (table) + `is_default`→`default`
  (column.go:49,53 — upstream keeps the legacy name under its own TODO),
  `project_issues.project_column_id`→`project_board_id` (issue.go:22),
  `project_workflows event/filters/actions`→`workflow_*`
  (workflows.go:164-166), `tracked_time.seconds`→`time` (tracked_time.go),
  `pull_auto_merges issue_id`→`pull_id` + `merge_message`→`message`
  (automerge.go:18,24), `audit_event.created_unix`→`timestamp_unix`
  (audit_event.go:38), `issue_subscriptions`→`issue_watch` table name
  (iff recorded — else keep, see FN-13). Zero API surface; do it in one
  generated migration to pay the rename tax once.
- **FN-6: repo_units completion.** Missing `id`, `created_unix`,
  `everyone_access_mode` (repo_unit.go:44,48,50 — the 2026 upstream
  everyone-permission column is a real capability gap). Enum-text family
  (`type`, `anonymous_access_mode`) stays under §2.3.
- **FN-7: pull_auto_merges completion.** Missing `merged_commit_id`
  (automerge.go:27 — the recorded merge result); ours-extra `sha` (the
  head-sha gate) stays as a recorded addition. Rides FN-5's renames.
- **FN-8: commit_statuses completion.** Missing `context_hash`
  (commit_status.go:51) + `index` (commit_status.go:42 — the per-sha
  monotonic index; pairs with the documented `commit_status_index`
  TODO in `api/services/commit-status.ts:88-91`). API-visible: upstream
  emits the per-sha index as the status `id`.
- **FN-9: the original_author family.** `releases`, `reactions`,
  `pull_reviews` each missing `original_author` + `original_author_id`
  (release.go:75-76, reaction.go:70-71, review.go:131-132) — upstream's
  columns for migrated/federated authorship. Additive NULLable ports.
- **FN-10: issue_pins + issue_labels pk completion.** `issue_pins`: add
  `id`, `is_pull` (issue_pin.go:19,22) and settle the inverted
  nullability on `repo_id`/`issue_id`; `issue_labels`: add `id`
  (issue_label.go:21) or record the composite-PK choice.
- **FN-11: package_blob_upload resumable state.** Missing
  `hash_state_bytes` (package_blob_upload.go:28 — the rolling upload
  checksum state); ours `chunk_count` is the recorded replacement —
  port-or-record.
- **FN-12: small completions.** `gpg_keys.emails` (gpg_key.go:34 — the
  serialized address list), `issue_dependency.updated_unix`
  (dependency.go:108), `repo_transfer.recipient_access_granted` +
  `updated_unix` (transfer.go:76,79), `repo_collaborators.id` +
  timestamp arm (collaboration.go:22), `lfs_locks.lower_path` record
  (ours-extra — keep, record in SPEC-0006).
- **FN-13: the record unit (no DDL) — DISPOSITIONED (2026-11-03), see §7.**
  The backlog's "ADR-0007 appendix" phrasing is superseded: ADR-0007's own
  test is "if the SPEC does not record it, it is drift", so the records
  landed in SPEC extensions (SPEC-0005 §3.2 as-built block; SPEC-0002
  §3 conventions + §4.6 item 16), with this §7 as the column-level
  disposition and errata to §2.5/§2.6/§2.7. Net result: (a) the
  strictness inversion (ours-stricter arm) → intentional-recorded;
  (b) timestamp-name + `uid` families → intentional-recorded, the mass
  rename declined; (c) the id-family extension rule → cites ADR-0007
  item 2 + §2.1, no new text; (d) the differing table names → per-table
  SPEC records + §7.5. Two ours-looser nullability inversions stay DRIFT:
  `issue_subscriptions.created_unix/updated_unix` (recommended carrier
  FN-12) and `issue_pins.repo_id` (FN-10); `users.email`/`avatar_email`
  become intentional-recorded via SPEC-0002 §4.6 item 16.
- **FN-14: the no-reader arm (port-when-read).** `user_open_id`,
  `team_invite`, `renamed_branch`, `commit_status_summary`, `app_state` —
  each ported as its own migration + SPEC only when a reader needs it
  (§3.3).

Dependency notes: FN-5's renames touch the same tables as FN-6/FN-7 —
land FN-5 after those two or fold their renames in; FN-3 and FN-2 are
independent; FN-4 is the only large one and is purely additive.

## 6. Reproducibility & sources

- Upstream census: the 117-row `RegisterModel` grep (§1); struct shapes
  parsed from `gitea/models/**` with the `GonicMapper{}` algorithm from
  `xe.SetMapper` (gitea/models/db/engine_init.go:55; algorithm =
  xorm `names/mapper.go gonicCasedName`, xorm v1).
- Ours census: parse of `apps/worker/src/db/schema.ts` (107 tables, 1010
  columns); upstream parse totals 117 tables / 1081 columns.
- SPEC cites: grep over `specs/**` per table name (§3 rows carry the
  hits); code cites are `api/services/*`, `ui/pages/*`,
  `services/actions/*` line numbers at this working tree.
- The lost FN report's numbers (~115/60/4) are superseded by this census's
  117/69+blanket/22; where the lost report is cited elsewhere (ADR-0007
  consequence 2), this file is the durable replacement.

## 7. FN-13 disposition — the record-not-migrate families (FN-13 unit, 2026-11-03)

FN-13 is the record unit: no DDL. ADR-0007's vocabulary is
platform-adapted / intentional-recorded / drift, and its test is "if the
SPEC does not record it, it is drift" — so each family below was
re-verified against both sources (schema.ts at this worktree, the
`gitea/` pin), classified, and recorded where the record must live: the
normative SPEC text landed as an as-built block in **SPEC-0005 §3.2**
(schema-wide family record; SPEC-0005 owns the largest D1 block and the
schema.ts conventions header points there) and in **SPEC-0002 §3 +
§4.6 item 16** (the users/PAT block's own members). This §7 is the
column-level disposition, the member census, and the errata to §2.

### 7.1 The NOT-NULL strictness inversion (ours-stricter arm) — intentional-recorded

Classification: **intentional-recorded**, via the SPEC-0005 §3.2 as-built
block. Explicitly NOT platform-adapted: D1/SQLite expresses column
nullability fine — the ground is effective-shape parity, not capability.
The recorded grounds: (1) upstream xorm INSERTs write every mapped field
with Go zero values, so upstream's effective row shape carries no
model-layer NULLs; (2) xorm reads SQL NULL back as the Go zero value, so
upstream's nullable DDL is indistinguishable from ours' NOT NULL +
default at every surface the ADR-0002 contract freezes — no reader can
observe the difference; (3) relaxing ours to upstream's DDL letter would
only weaken integrity, for zero parity gain. The census counts stand as
the §1 parser produced them (386 inverted columns; ~269 upstream `NOT
NULL` tags over 1081 columns vs ~715 ours `.notNull()` over 1010 — this
unit re-counted the two totals as corroboration, spot-checked the
per-column list at §7.7, and did NOT re-derive it column-by-column).

The ours-looser arm is a different thing and is NOT blessed by this
record. Verified members:

| column | ours | upstream | disposition |
|---|---|---|---|
| `issue_subscriptions.created_unix` / `.updated_unix` | NULLable (schema.ts:999-1000) | `NOT NULL` (models/issues/issue_watch.go:20-21) | **stays DRIFT** — tightening queued; recommended carrier FN-12 (small completions, same-table DDL); census row §3.1 reclassified aligned → drift |
| `issue_pins.repo_id` | NULLable TEXT (schema.ts:1096) | `int64 UNIQUE(s) NOT NULL` (models/issues/issue_pin.go:20) | **stays DRIFT** — rides FN-10 (also a TEXT id-family column, §2.1) |
| `users.email` / `users.avatar_email` | NULLable (schema.ts:440, 457) | `NOT NULL` (models/user/user.go:101, 149) | **intentional-recorded** via SPEC-0002 §4.6 item 16 — part of the recorded users reduction: orgs ARE user rows here and the org-create surface writes `email: input.email ?? null`, `avatarEmail: null` (services/orgs/orgs.ts:430-437); upstream's org-as-user-row survives the same NOT NULL only because xorm writes the Go zero `''` for the never-set fields (CreateOrganization, models/organization/org.go:316-337, sets no Email) — ours models "no email" as NULL where upstream stores `''`; same information, different zero convention |
| `repo_transfer.created_at` | NOT NULL DEFAULT unixepoch (schema.ts:314-316) | `INDEX NOT NULL created` (models/repo/transfer.go:77) | parity-strict — checked because §2.7's itemization hinted at it; no inversion |

Errata to §2.7's minority-arm itemization (recorded here; §2's text left
as written): `issue_pins.issue_id` is NOT inverted (ours is the
composite PK, NOT NULL — schema.ts:1095 — vs upstream `NOT NULL`,
issue_pin.go:19: same strictness); the §3.1 census row's `pin_order`
claim is likewise withdrawn (ours NOT NULL — schema.ts:1097 — vs
upstream nullable `DEFAULT 0`, issue_pin.go:22: that direction is the
ours-stricter blanket, not an inversion).

### 7.2 The timestamp-name family — intentional-recorded; mass rename declined

Erratum to §2.5 first: the family as §2.5 sketched it is wrong on two of
three arms, and the true divergence is SMALLER than "~30 tables":

1. **The actions family (`created`/`updated`) is NOT a divergence.**
   Upstream's fields are literally `Created`/`Updated`
   `timeutil.TimeStamp` with the xorm auto-fill tags — models/actions/
   run.go:74-75, run_job.go:135-136, task.go:57-58, task_step.go:32-33,
   runner.go:70-71, runner_token.go:39-40, run_attempt.go:38-39,
   run_job_summary.go:52-53, schedule.go:36-37, schedule_spec.go:33-34,
   artifact.go:87-88, tasks_version.go:23-24, scoped_workflow.go:30-31,
   variable.go:38-39 — and GonicMapper renders those field names as the
   column names `created`/`updated`. Ours matches verbatim
   (schema.ts:3980-3981, 4015-4016, 4076-4077, 4158-4159, 4198-4199,
   4251-4252, 4294-4295, 4342-4343, 4380-4381, 4422-4423, 4509-4510,
   4538-4539). Parity — removed from the family.
2. **The SPEC-0005-era tables already carry upstream's `*_unix` names.**
   `issues` schema.ts:638-639, `comments` :775-776, `labels` :877-878,
   `reactions` :904, `releases` :949, `release_assets` :978,
   `issue_subscriptions` :999-1000, `commit_statuses` :1081-1082,
   `webhooks` :1158-1159, `webhook_deliveries` :1200,
   `issue_dependency` :1895, `tracked_time` :1923, `stopwatch` :1947,
   `issue_attachments` :2113, `public_keys` :2349-2352, `gpg_keys`
   :2394, `pull_reviews` :2462-2463, `protected_branches` :2502-2503,
   `deploy_keys` :2575-2578, `secrets` :2640, `action_variables`
   :2681-2684, `projects` :2964-2966, `oauth2_application` :3186-3188 —
   parity names; the `*_at` suffixes there are Drizzle PROPERTY names
   (camelCase, schema-side only) and never the SQL name.
3. **The true divergence — 16 paired tables where ours uses
   `created_at`/`updated_at` (or bare-`created` counterparts) SQL names
   against upstream's `created_unix`/`updated_unix`/`created`:**

| our table (ours cite) | upstream cite | upstream names | ours names |
|---|---|---|---|
| `repositories` (schema.ts:79,85) | models/repo/repo.go:219-220 | created_unix, updated_unix | created_at, updated_at |
| `repo_transfer` (schema.ts:314) | models/repo/transfer.go:77 | created_unix (updated_unix MISSING on ours — FN-12) | created_at |
| `users` (schema.ts:488,529) | models/user/user.go:122-124 | created_unix, updated_unix, last_login_unix | created_at, last_login_at |
| `personal_access_tokens` (schema.ts:566) | models/auth/access_token.go:30-31 | created_unix, updated_unix | created_at (no updated column on ours — upstream `updated_unix` feeds only `HasUsed`/`HasRecentActivity`, replaced by the SPEC-0002 §2.7/§4.6 items 5+13 last-used-throttle record) |
| `lfs_objects` (schema.ts:1252-1253) | models/git/lfs.go:84-85 | created_unix, updated_unix | created_at, updated_at |
| `lfs_locks` (schema.ts:1294) | models/git/lfs_lock.go:27 | created | created_at |
| `user_redirects` (schema.ts:1392) | models/user/redirect.go:38-42 — NO timestamp columns upstream | — | created_at (ours-extra column, not a rename) |
| `repo_redirects` (schema.ts:289) | models/repo/redirect.go:39-43 — NO timestamp columns upstream | — | created_at (ours-extra column, not a rename) |
| `repo_watchers` (schema.ts:1480) | models/repo/watch.go:44 | created_unix | created_at |
| `repo_collaborators` (schema.ts:1506-1507) | models/repo/collaboration.go:25-26 | created_unix, updated_unix | created_at, updated_at |
| `follows` (schema.ts:1560) | models/user/follow.go:17 | created_unix | created_at |
| `stars` (schema.ts:1592) | models/repo/star.go:21 | created_unix | created_at |
| `repo_mirrors` (schema.ts:1753-1765) | models/repo/mirror.go:30-32 | updated_unix, next_update_unix, last_sync_unix (NO created column upstream) | updated_at, next_sync_at, last_sync_at (ours created_at is an ours-extra column — upstream `Mirror` has no created field) |
| `notification_states` (schema.ts:1823) | models/activities/notification.go:71-72 | created_unix, updated_unix (both NOT NULL) | updated_at (ours created arm absent — rides the row's residual) |
| `user_blocking` (schema.ts:2798) | models/user/block.go:31 | created_unix | created_at |
| `push_mirrors` (schema.ts:2894) | models/repo/pushmirror.go:30 | last_update_unix | next_sync_at (its `created_unix` at schema.ts:2865 is parity — the table mixes both families) |

Decision: **record, not rename** (the backlog's alternative is
declined). Grounds: no API surface reads SQL column names (the ADR-0002
freeze is HTTP-level; renderers name their own fields); a mass rename is
16 tables of migration + re-verified renderer/index rewrites for zero
behavior or parity-of-behavior gain; the VALUE convention (unix seconds,
`integer` + `mode: "timestamp"`) is already uniform and recorded
(schema.ts header; SPEC-0002 §3; SPEC-0005 §3.2 opening line). The
record's normative home is the SPEC-0005 §3.2 as-built block; the table
above is the member census. Knock-on dispositions: FN-4's
"`created_unix`/`updated_unix` arm" for `repositories` is superseded —
when FN-4 lands, do NOT port those as new columns; the existing
`created_at`/`updated_at` carry the values. FN-12's new timestamp
columns (`repo_transfer.updated_unix`, `issue_dependency.updated_unix`
is already parity-named) land under the RECORDED family names of their
table, not upstream's literal names.

Not members (parity `*_unix`/`created` names already): `two_factor`
(schema.ts:5032-5033), `webauthn_credentials` (:5116-5118),
`login_source` (:4861-4862), `external_login_user` block, `pull_auto_merges`
(:5005), `review_state` (:4975), `system_notices` (:3891), `audit_event`
(:3552 — upstream's own name is `timestamp_unix`, audit_event.go:38;
that stays FN-5's table-specific rename), `system_keystore`
(:4600-4603), `cron_state`, `oauth2_grant`/`oauth2_authorization_code`
(:3236-3237; upstream oauth2.go:512-513), `milestones.deadline_unix`/
`closed_date_unix` (schema.ts:879-880), `labels.archived_unix` (:823),
`issues.deadline_unix`/`closed_unix` (:648-650). Ours-extra tables with
`-_at` names have no upstream counterpart and are convention members,
not divergences: `repo_settings` (:1534), `repo_imports.heartbeat_at`
(:1350), `email_outbox.sent_at` (:4703), `email_inbound` (:4774-4775),
`sessions` (:1993-1997 — SPEC-0010's recorded redesign names),
`federation_followers` (:5168), PAT `last_used_at`/`expires_at`
(:562,565 — SPEC-0002 §4.6 items 4-5 additions).

### 7.3 The `uid` → `user_id` family — intentional-recorded

Erratum to §2.6 first: **`follow` is NOT a member.** Upstream
`Follow.UserID int64 xorm:"UNIQUE(follow)"` (models/user/follow.go:17)
renders `user_id` under GonicMapper, and upstream's own queries bind
`user_id` (follow.go `builder.Eq{"user_id": …}`); ours `follows.user_id`
(schema.ts:1554) is parity. The census row for `follow` ("aligned") was
already right; §2.6's member list was not.

Upstream's `UID int64` columns render `uid` (the GonicMapper result,
confirmed by upstream's own SQL: models/repo/star.go:73
`builder.Eq{"uid": …}`, models/auth/access_token.go:66,
models/auth/twofactor.go:161, models/organization/team_user.go:28).
The members where ours renames to `user_id`:

| upstream table (cite) | ours (cite) | recorded at |
|---|---|---|
| `access_token` (access_token.go:22) | `personal_access_tokens.user_id` (schema.ts:549) | SPEC-0002 §3 |
| `star` (star.go:19) | `stars.user_id` (schema.ts:1588) | SPEC-0005 §3.2 block |
| `org_user` (org_user.go:28) | `org_members.user_id` (schema.ts:1384) | SPEC-0007 §3.3 + SPEC-0005 §3.2 block |
| `issue_user` (issue_user.go:17) | `issue_user.user_id` (schema.ts:1039) | SPEC-0005 §3.2 block; schema.ts doc comment already records "UID maps to user_id per the tree convention" |
| `team_user` (team_user.go:20) | `team_members.user_id` (schema.ts:2224) | SPEC-0007 + SPEC-0005 §3.2 block |
| `email_address` (email_address.go:85) | `email_addresses.user_id` (schema.ts:2295) | SPEC-0005 §3.2 block |
| `two_factor` (twofactor.go:54) | `two_factor.user_id` (schema.ts:5024) | SPEC-0022 + SPEC-0005 §3.2 block |

Classification: **intentional-recorded** — `uid` is Gitea-legacy
shorthand (upstream's own newer tables use `UserID`: follow.go:17,
watch.go, notification.go, webauthn.go), `user_id` is the clearer name,
and no API surface crosses SQL names. Rename declined (same grounds as
§7.2). Parity members, for the record: `oauth2_application.uid` keeps
upstream's name verbatim (oauth2.go:41 vs schema.ts:3173) — the one
table where the rename was NOT applied; and `follow`/`watch` upstream
columns are already `user_id`. `user_openid`'s UID (openid.go:20) sits
in the missing-table arm (§3.3), not here.

### 7.4 FN-13(c): the id-family extension rule — already recorded

No new record text needed: the rule IS ADR-0007 item 2 (the TEXT
`repositories.id` id space, the K11 fact pinned in `3ed025d`) plus §2.1's
corollary flag, which states the extension rule. Restated once for this
unit's cite: every NEW table/column joining the TEXT id family inherits
the intentional-recorded classification; any TEXT id NOT derived from
`repositories.id` is candidate drift and needs its own record. (A live
example of the boundary working: `issue_pins.repo_id` above — TEXT and
id-family-derived, so its TEXT-ness inherits the record; its NULLability
does not, and queues as FN-10.)

### 7.5 FN-13(d): table names that intentionally differ — recorded per table

Already recorded (census cites verified): `hook_task` →
`webhook_deliveries` (SPEC-0005 §3.6 — erratum: the §3.1 row said §3.7,
a section that does not exist; corrected), `mirror` → `repo_mirrors`
(SPEC-0009 §3), `push_mirror` → `push_mirrors` (SPEC
push-mirror-outbound), `lfs_meta_object` → `lfs_objects` (SPEC-0006 §3),
`notice` → `system_notices` (SPEC-0018 §4.1 — plural + int type),
`access_token` → `personal_access_tokens` (SPEC-0002 §2.7/§3),
`user_setting` → `user_settings_kv` (specs/user-notification-settings.md),
`notification` → `notification_states` (specs/email-outbound.md +
user-notification-settings.md), `session` → `sessions` redesign
(SPEC-0010), `upload`/`attachment` → `issue_attachments` +
`release_assets` (SPEC-0005 §3.2 records the split rationale),
`user_setting`-adjacent profile store → `user_settings` (§3.2 row).

Newly recorded by the SPEC-0005 §3.2 block (association renames with no
prior upstream-mapping record): `issue_watch` → `issue_subscriptions`,
`review` → `pull_reviews`, `collaboration` → `repo_collaborators`,
`watch` → `repo_watchers`, `team_user` → `team_members`, `team_repo` →
`team_repo_access`, `org_user` → `org_members` (SPEC-0007 §3.3 records
the table's role enum; the name mapping rides the block record). Not
members: `follows`/`stars` are §2.2's plural rule; `deleted_branches`
has no upstream counterpart (§3.2's own flag stands — not a name
divergence).

### 7.6 Census cells changed by this unit

- §3.1 `issue_watch` row: **aligned → drift** — the ours-looser
  timestamp nullability (§7.1); recommended carrier FN-12.
- §3.1 `user` row: reason extended — email/avatar_email nullability now
  carries its SPEC-0002 §4.6 item 16 record (verdict unchanged:
  intentional-recorded).
- §3.1 `issue_pin` row: reason corrected — only `repo_id` inverts;
  `pin_order`/`issue_id` claims withdrawn (§7.1 errata); verdict
  unchanged (drift, FN-10).
- §3.1 `collaboration` row: reason corrected — `created_unix`/
  `updated_unix` are PRESENT as `created_at`/`updated_at` (§7.2); only
  `id` is missing (FN-12); verdict unchanged (drift).
- §3.1 `lfs_lock` row: reason annotated — `created` → `created_at` is
  the §7.2 recorded family; verdict unchanged (drift: ours-extra
  `lower_path`, FN-12).
- §3.1 `hook_task` row: SPEC cite corrected §3.7 → §3.6 (the §7.5
  erratum); verdict unchanged.
- §5 FN-13 bullet: replaced with the disposition pointer (top of §7).
- No other verdict cells moved: the "aligned — blanket families only"
  rows stay aligned now that the blanket families carry records
  (SPEC-0005 §3.2 block + §2's own cites), and every remaining drift row
  keeps its structural reason, queued FN-1..FN-12 as before.

### 7.7 Spot-verification (both-side cites checked at the pin)

| # | column | ours | upstream | result |
|---|---|---|---|---|
| 1 | `comments.type` | notNull (schema.ts:745) | `Type CommentType` untagged → nullable (models/issues/comment.go:275) | ours-stricter ✓ |
| 2 | `comments.issue_id` | notNull (schema.ts:747) | `IssueID int64 xorm:"INDEX"` → nullable (comment.go:284) | ours-stricter ✓ |
| 3 | `comments.invalidated` | notNull default false (schema.ts:768) | `Invalidated bool` → nullable (comment.go `Invalidated` field) | ours-stricter ✓ |
| 4 | `issues.title` | notNull (schema.ts:624) | `Title string xorm:"name"` → nullable (models/issues/issue.go:63) | ours-stricter ✓ — and a SIDE-FIND, see below |
| 5 | `issue_pins.repo_id` | nullable TEXT (schema.ts:1096) | `int64 UNIQUE(s) NOT NULL` (issue_pin.go:20) | ours-looser inversion ✓ |
| 6 | `issue_subscriptions.created_unix` / `.updated_unix` | nullable (schema.ts:999-1000) | `created NOT NULL` / `updated NOT NULL` (issue_watch.go:20-21) | ours-looser inversion ✓ |
| 7 | `users.email` / `.avatar_email` | nullable (schema.ts:440,457) | `NOT NULL` (user.go:101,149) | ours-looser inversion ✓ — recorded, SPEC-0002 §4.6 item 16 |
| 8 | `follows.user_id` | `user_id` (schema.ts:1554) | `UserID` → `user_id` (follow.go:17; query binds `user_id`) | parity ✓ — §2.6 erratum |
| 9 | `stars.user_id` | `user_id` (schema.ts:1588) | `UID` → `uid` (star.go:19; query binds `uid` at star.go:73) | rename member ✓ |
| 10 | `action_runs.created` / `.updated` | `created`/`updated` (schema.ts:4076-4077) | `Created`/`Updated` fields → `created`/`updated` columns (run.go:74-75) | parity ✓ — §2.5 erratum |
| 11 | `repo_transfer.created_at` | NOT NULL DEFAULT unixepoch (schema.ts:314-316) | `INDEX NOT NULL created` (transfer.go:77) | parity-strict ✓ (checked, no inversion) |
| 12 | `reactions.user_id`/`.type` | notNull (schema.ts:897-905) | `UNIQUE(s) NOT NULL` (reaction.go:66-72) | parity-strict ✓ (the blanket is not universal — parity-strict columns exist and are not family members) |

Side-find (NOT a FN-13 family — flagging for the census owner):
`issues.title` (schema.ts:624) vs upstream column **`name`** —
`Issue.Title string xorm:"name"` (issue.go:63) is a column-NAME tag;
upstream edits the title via `UpdateIssueCols(ctx, issue, "name")`
(models/issues/issue_update.go:198) and searches it as `` `name` ``
(issue.go:536). `milestones.name` (schema.ts:871) and `labels.name`
(schema.ts:817) ARE parity. The `issues` census row's "aligned" verdict
and §4 (which has no `issues` subsection) miss this rename; FN-5's
rename batch is the natural carrier if the census owner queues it.
This unit did NOT reclassify the `issues` row — outside FN-13's
families and outside this unit's cell ownership.

Corroboration counts (not a re-derivation): upstream `NOT NULL` xorm
tags ≈ 269 over 1081 census columns; ours `.notNull()` = 715 over 1010
(schema.ts grep, PK columns excluded by their own declaration shape).
Direction and magnitude corroborate §2.7; the 386 figure stays the §1
parser's census number.

Errata index (recorded here; the §2/§4 text left as written by the
census owner to fold): §2.5 actions arm is parity, not divergence, and
the SPEC-0005-era claim is inverted (those tables are the parity side);
§2.6 `follow` is not a member, and `org_user`/`access_token`/
`two_factor` are missing members; §2.7's itemization overstates the
ours-looser arm (`issue_id`/`pin_order` withdrawn); §4 `repo_transfer`
cites transfer.go:79 for `updated_unix` — the field is at :78 (:76
`RecipientAccessGranted` is correct); §3.1 `hook_task` row cites
SPEC-0005 §3.7 — the delivery section is §3.6.

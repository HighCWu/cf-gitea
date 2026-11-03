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
- **Verdicts over the 117 upstream tables** (reconciled by the §7.9
  cite-audit: the three original_author-family rows flipped drift →
  intentional-recorded per the landed §7.11 record):
  - **46 aligned** (structure faithful; only the blanket families of §2 apply)
  - **26 intentional-recorded** (a SPEC or code-level record owns the divergence)
  - **23 drift** (accidental divergence — the migration backlog, §5/FN)
  - **22 missing-table** (no counterpart; §3.3 splits the no-reader arm)
  - *(0 platform-adapted PAIRS — platform adaptation shows up in the blanket
    families of §2 and in the missing-table rows, not as whole-table rewrites)*
- **Ours-extras: 12** tables with no upstream counterpart (§3.4).
- The lost report's "~115 tables / ~60 drifted columns / 4 missing tables"
  is **superseded**: this census counts 117 / 63 table-specific drift
  columns (+ the blanket families and the 26-column `repositories`
  residual) / **22 missing tables**. The 63 = 31 MISSING + 21 RENAME +
  4 OURS-EXTRA + 7 TYPE after the §4 patch-parity erratum (the as-run
  figure was 65); of the 31 MISSING, 8 — the four original_author pairs —
  are recorded-absent per §7.11, not port targets (the three
  flipped-table pairs of §7.11 §7 plus comment's own pair, which is why
  FN-2 ports 5, not 7). The 4-missing-table
  figure undercounts by counting only data tables a reader would touch;
  this census counts every registered upstream table.
- **Recommended first three migration units: FN-1 (pull_requests.status
  stored-enum swap), FN-3 (review_state.updated_files — the per-file
  viewed map), FN-2 (comments mutation-metadata completion).** See §5.
  Landing state (updated by the §7.9 cite-audit, 2026-11-03): FN-1 LANDED
  (migration 0064, the stored-enum swap — verified), FN-3 LANDED
  (migration 0065, `updated_files` + the read ladder — the §3.1 row and
  the §4 section carry the landed annotations), FN-6 LANDED (migration
  0066, repo_units `id`/`created_unix`/`everyone_access_mode` — the §3.1
  row and the §4 section carry the landed annotations; the toggle-stamp
  follow-up landed as its own fix), FN-2 LANDED (migration 0067, the
  comments mutation-metadata five after §7.11 recorded the original_author
  pair absent — the §4 `comment` row, the derivation expansion's column
  rows, and the §5 section carry the landed annotations; SPEC-0005 §7 is
  the as-built record). The next OPENING units per this
  audit's own ordering (API-visible first, records last) are therefore
  FN-7 (pull_auto_merges,
  riding FN-5's renames), and FN-4 (repositories upstream-column
  completion, purely additive).

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
parser). **The override rule (added 2026-11-03 after two false drifts,
§7.8): GonicMapper runs ONLY when the tag does not name the column — an
explicit FIRST tag token wins, and a quoted first token pins a legacy
name.** `xorm:"redirect_uris JSON TEXT"` sets the column to `redirect_uris`
(never a mapper quirk); `xorm:"'branch_name' UNIQUE(s)"` pins
`branch_name`; a tag of bare type tokens (`JSON TEXT`, `NOT NULL`,
`UNIQUE`, `INDEX ...`) leaves the field to the mapper. Before classifying
ANY gonic-quirk rename, read the tag's first token — the original parse
skipped this and produced two false renames (oauth2_application and the
package_blobs hashes, both withdrawn in §7.8). The true quirk names are
the trailing-initialism splits whose tags carry no column token:
`team_i_ds` (`TeamIDs`, transfer.go:72),
`allowlist_team_i_ds`/`allowlist_user_i_ds` (`AllowlistTeamIDs`/
`AllowlistUserIDs`, protected_tag.go:27-28) — the
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
   (`comments.removed_assignee` — schema.ts:820, now the only one: the
   other two this list once named, `users.repo_admin_change_team_access`
   and `repositories.close_issues_via_commit_in_any_branch`, have since
   gained the wrapper at schema.ts:540-543 / :73-77 — erratum flagged by
   the FN-4 unit, verified and folded by the §7.9 cite-audit) —
   storage-equal, cosmetic only.
5. **Timestamp column names — drift family (cosmetic; FN-13 disposition:
   record, not rename).** Ours `created_at`/`updated_at` vs upstream
   `created_unix`/`updated_unix` on 16 paired tables — the member census
   with both-side cites is §7.2. Folded erratum (2026-11-03, §7.8): this
   family's original sketch here was wrong on both of its arms — the
   actions family (`created`/`updated`) is PARITY (upstream's fields are
   literally `Created`/`Updated` and GonicMapper renders exactly those
   column names), and the SPEC-0001/0005-era tables are the parity side
   too (they carry upstream's `*_unix` names verbatim; the `*_at`
   suffixes there are Drizzle PROPERTY names, never SQL names). What
   survives of the original text: nothing recorded the choice until
   FN-13 landed the SPEC-0005 §3.2 as-built block (SPEC-0018 §4.1 had
   used `created_unix` for parity when it landed post-ADR), and names
   never cross the API (Drizzle property names are already camelCase;
   the JSON renderers name their own fields) — the lowest-stakes family.
6. **`uid` → `user_id` renames — recorded family (FN-13:
   intentional-recorded, rename declined, §7.3).** Members: `star`,
   `issue_user`, `team_user`, `email_address`, `org_user`,
   `access_token`, `two_factor` (7 tables; the member table with
   both-side cites is §7.3). Folded erratum (2026-11-03, §7.8): the
   original list here named `follow` — NOT a member (upstream's field is
   `UserID`, follow.go:18, rendering `user_id`: parity) — and omitted
   `org_user`/`access_token`/`two_factor`.
7. **NOT-NULL strictness inversion — drift class (386 columns), recommend
   record-not-migrate.** Upstream xorm leaves columns nullable unless the
   tag says `NOT NULL`; ours declares `notNull()` far more widely. Ours is
   the *stricter* shape and matches upstream's actual INSERT behavior
   (xorm writes every mapped field); relaxing our columns to match
   upstream's DDL would only weaken integrity. The ADR vocabulary has no
   "stricter-than-upstream" class, so honestly: drift by the letter,
   resolved by RECORDING (an ADR-0007 appendix note), not by DDL. The
   handful of inversions where OURS is the nullable side are itemized in
   §7.1's verified-members table (`issue_pins.repo_id`,
   `issue_subscriptions.created_unix/updated_unix`,
   `users.email/avatar_email`; an earlier `issue_pins.issue_id` member
   here was withdrawn — ours is the composite PK and NOT NULL, the same
   strictness as upstream, issue_pin.go:20 vs schema.ts:1095).

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
| `commit_status` | models/git/commit_status.go:37 | schema.ts:1256 `commit_statuses` | drift | missing context_hash, index — DERIVED, port plan staged (§7.12; SPEC-0005 §10 PLAN ONLY); ours cite re-grepped 2026-11-04 (drifts under concurrent schema edits: :1066 as-of-audit → :1250 → :1256; re-grep at landing) |
| `commit_status_index` | models/git/commit_status.go:330 | — | missing-table | no table; autoincrement id substitutes, documented TODO(SPEC-0005) (api/services/commit-status.ts:88-91,143-145); the FN-8 port plans the table + the max-index seed (§7.12, SPEC-0005 §10 PLAN ONLY) |
| `lfs_lock` | models/git/lfs_lock.go:21 | schema.ts:1281 `lfs_locks` | drift | ours-extra lower_path (schema.ts:1293, unrecorded case-fold lookup; FN-12 records it); `created` → `created_at` is the FN-13 §7.2 recorded timestamp-name family |
| `package_blob` | models/packages/package_blob.go:30 | schema.ts:3693 `package_blobs` | intentional-recorded | hash-rename claim WITHDRAWN (§7.8): upstream carries explicit overrides `hash_md5/hash_sha1/hash_sha256/hash_sha512` (package_blob.go:33-36), ours matches verbatim (schema.ts:3700-3704); the real divergence is ours-NULLable md5/sha1/sha512 vs upstream NOT NULL — recorded, SPEC-0016 package_blobs bullet + the schema.ts table comment (WebCrypto has no MD5) |
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
| `review_state` | models/pull/review_state.go:41 | schema.ts:4965 `review_state` | drift — LANDED by FN-3 (2026-11-03, migration 0065; `updated_files` ported, the SPEC record `specs/table-alignment-fn3-review-state.md`) | was: missing updated_files (per-file viewed map; ours stored cursor only, api/ui pull-files.tsx:642) |
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
| `issue_pin` | models/issues/issue_pin.go:17 | schema.ts:1093 `issue_pins` | drift | missing id, is_pull (issue_pin.go:18,21); repo_id ours-NULLable TEXT vs upstream NOT NULL int64 (issue_pin.go:19 vs schema.ts:1096 — §7.1); FN-10 carries; §7.1 erratum: pin_order/issue_id are NOT inversions (ours is the stricter side) |
| `reaction` | models/issues/reaction.go:62 | schema.ts:894 `reactions` | intentional-recorded | original_author/original_author_id recorded-absent (§7.11, SPEC-0005 §9; cites :69-70 — the off-by-one :70-71 corrected by the cite-audit) |
| `review` | models/issues/review.go:123 | schema.ts:2438 `pull_reviews` | intentional-recorded | original_author/original_author_id recorded-absent (§7.11, SPEC-0005 §9; cites :130-131 — the off-by-one :131-132 corrected by the cite-audit) |
| `issue_assignees` | models/issues/assignees.go:17 | schema.ts:1863 `issue_assignees` | aligned | blanket families only (id / timestamp-name / strictness) |
| `pull_request` | models/issues/pull.go:120 | schema.ts:680 `pull_requests` | drift | FN-1 status-enum swap IN FLIGHT (migration 0064 + schema.ts:588-596 re-map); still missing type, changed_protected_files; ours-extra head_sha (documented) |
| `milestone` | models/issues/milestone.go:47 | schema.ts:866 `milestones` | aligned | blanket families only (id / timestamp-name / strictness) |
| `stopwatch` | models/issues/stopwatch.go:20 | schema.ts:1940 `stopwatch` | aligned | blanket families only (id / timestamp-name / strictness) |
| `issue` | models/issues/issue.go:54 | schema.ts:610 `issues` | drift | upstream column `name` → ours `title`: the field carries the explicit xorm column-NAME tag `xorm:"name"` (issue.go:63), which upstream's own SQL binds (writes: `UpdateIssueCols(ctx, issue, "name")`, issue_update.go:198; search: the backticked column, issue.go:536); ours declares `title` (schema.ts:624) — FN-5 carrier (§7.8); the rest is blanket families (id / timestamp-name / strictness) |
| `comment` | models/issues/comment.go:273 | schema.ts:740 `comments` | drift | missing 7 mutation-metadata cols (comment_meta_data, project_id, old_project_id, time_id, assignee_team_id, original_author, original_author_id); the census's 8th, patch_quoted, WITHDRAWN by the §4 erratum (upstream's column IS patch: parity); the original_author pair now recorded-absent (§7.11), leaving 5 PORT columns for FN-2 — the 5 LANDED (migration 0067, pure ADD COLUMN + the JSON-gated backfills; the writers/readers ride SPEC-0005 §7 as-built; patch untouched) |
| `issue_content_history` | models/issues/content_history.go:20 | schema.ts:3455 `issue_content_history` | aligned | blanket families only (id / timestamp-name / strictness) |
| `tracked_time` | models/issues/tracked_time.go:22 | schema.ts:1913 `tracked_time` | drift | time → seconds column rename (unit kept seconds) |
| `issue_dependency` | models/issues/dependency.go:101 | schema.ts:1885 `issue_dependency` | drift | missing updated_unix |
| `issue_user` | models/issues/issue_user.go:15 | schema.ts:1034 `issue_user` | aligned | blanket families only (id / timestamp-name / strictness) |
| `issue_watch` | models/issues/issue_watch.go:17 | schema.ts:992 `issue_subscriptions` | drift | FN-13 §7.1: created_unix/updated_unix ours-NULLable vs upstream NOT NULL (issue_watch.go:22-23 vs schema.ts:999-1000) — the ours-looser arm, NOT covered by the strictness record; recommended carrier FN-12; table name + the rest are the FN-13 §7.2/§7.5 recorded families |
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
| `oauth2_application` | models/auth/oauth2.go:39 | schema.ts:3168 `oauth2_application` | aligned | gonic-rename claim WITHDRAWN (§7.8): upstream carries the explicit override `RedirectURIs xorm:"redirect_uris JSON TEXT"` (oauth2.go:51), ours `redirect_uris` matches verbatim (schema.ts:3184); the rest is blanket families only (id / timestamp-name / strictness) |
| `oauth2_authorization_code` | models/auth/oauth2.go:403 | schema.ts:3253 `oauth2_authorization_code` | aligned | blanket families only (id / timestamp-name / strictness) |
| `oauth2_grant` | models/auth/oauth2.go:504 | schema.ts:3215 `oauth2_grant` | aligned | blanket families only (id / timestamp-name / strictness) |
| `mirror` | models/repo/mirror.go:23 | schema.ts:1720 `repo_mirrors` | intentional-recorded | sync-state/credentials restructure; SPEC-0009 §3 (schema.ts:1720) |
| `repo_archiver` | models/repo/archiver.go:65 | — | missing-table | archives built on demand and streamed; SPEC-0004 §2.4 (api/services/archive.ts:1-8) |
| `collaboration` | models/repo/collaboration.go:20 | schema.ts:1500 `repo_collaborators` | drift | missing id (FN-12); created_unix/updated_unix are PRESENT as created_at/updated_at (FN-13 §7.2 recorded family — the old reason miscounted them missing); mode is the TEXT-enum blanket (§2.3) |
| `watch` | models/repo/watch.go:39 | schema.ts:1475 `repo_watchers` | aligned | blanket families only (id / timestamp-name / strictness) |
| `release` | models/repo/release.go:67 | schema.ts:930 `releases` | intentional-recorded | original_author/original_author_id recorded-absent (§7.11, SPEC-0005 §9; cites :74-75 — the off-by-one :75-76 corrected by the cite-audit) |
| `language_stat` | models/repo/language_stats.go:19 | — | missing-table | on-demand extension-sum reduction; SPEC-0004 divergence note (api/services/languages.ts:1-15) |
| `repo_unit` | models/repo/repo_unit.go:42 | schema.ts:341 `repo_units` | drift — LANDED by FN-6 (2026-11-03, migration 0066; `id`/`created_unix`/`everyone_access_mode` ported, the SPEC record is the SPEC-0003 §3.1 as-built block) | was: missing id, created_unix, everyone_access_mode (repo_unit.go:43,47,49 — the original cites here and in §4 were off by one, corrected at landing) |
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
| `external_login_user` | models/user/external_login_user.go:47 | schema.ts:4891 `external_login_user` | intentional-recorded | raw_data dropped, tokens written empty; external-auth-sources §4.3 (both decisions recorded inline; upstream shape §2.6 — the SPEC's §7.6/§7.8 are edge-case list items, not sections; cite corrected §7.8) (schema.ts:4891) |
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
| `repo_counters` | schema.ts:417 | intentional-recorded | consolidated per-repo number allocators (`issue_index`, `run_index`) — the platform-idiomatic merge of upstream's per-resource index tables; recorded SPEC-0005 §3.1 (the allocation decision + the schema line) + SPEC-0012 §4.5 (`run_index`). Known ours-extra per the audit brief; comment-verified. |
| `auth_failures` | schema.ts:575 | intentional-recorded | brute-force throttle ledger; recorded SPEC-0002 §3 (the Drizzle row; §2.7's per-IP window posture). |
| `repo_imports` | schema.ts:1322 | intentional-recorded | import/migration task rows; recorded SPEC-0003 §3.1 (columns + the staged state; SPEC-0009 consumes the §3.1/§3.3 tables). |
| `repo_settings` | schema.ts:1523 | intentional-recorded | per-repo PATCH round-trip side row (the `has_*` unit flags; description/website legacy since migration 0068 — SPEC-0001 §4.1); recorded SPEC-0004 §3 item 6 — the census gap this unit closed (the old bare "SPEC-0004" cite had no table record behind it). |
| `user_settings` | schema.ts:1611 | intentional-recorded | columnar profile-prefs side store (theme/language/hide_email/hide_activity/diff_view_style/email_notifications_preference); recorded user-notification-settings.md §4 (the migration-0008 side store + the non-interference ground) + SPEC-0020 (the `user_settings_kv` contrast). Upstream's `user_setting` KV is separately ported 1:1 as `user_settings_kv`. |
| `action_log_chunks` | schema.ts:4446 | intentional-recorded | hot log bytes per task — the `dbfs` analog on R2/D1; recorded SPEC-0012 §4.3 (schema.ts:3906,4439). |
| `system_keystore` | schema.ts:4593 | intentional-recorded | instance keystore (JWT/OIDC material); recorded SPEC-0012 §4.4 + §4.6 entry 7 (migration 0042, RESOLVED 3bc5d29; the old cite's "SPEC-0018 §1" arm carries no keystore record — corrected here) (schema.ts:4550-4562) — upstream keeps these in app.ini/AppData files, which the substrate lacks. |
| `cron_state` | schema.ts:4636 | intentional-recorded | cron tick bookkeeping; recorded SPEC-0020 §4.1 (migration 0044). |
| `email_outbox` | schema.ts:4664 | intentional-recorded | outbound mail rows; recorded email-outbound.md §4.1 (the DDL, migration 0049). |
| `email_inbound` | schema.ts:4722 | intentional-recorded | inbound mail rows; recorded email-inbound.md §5 (the DDL, migration 0054). |
| `deleted_branches` | schema.ts:4939 | intentional-recorded | the deleted arm of upstream's `branch` table (restore source: tip sha at delete time, actor, timestamp) split into its own table; the live arm is engine-derived. Recorded SPEC-0008 §3.1 as-built amendment (migration 0059; the PRE-CAS write + restore-replay ground) — the GR "fold into the next schema-touching SPEC" flag, closed by this unit. |
| `federation_followers` | schema.ts:5160 | intentional-recorded | ActivityPub follower store; recorded federation.md §5 Tier B as-built (migration 0063, the ADR-0007 S-1 grant — intentional-recorded-with-predecessor). |

Record sweep (RECORDS unit, 2026-11-04): every row re-tested against the
SPECs (grep for table/column). 10/12 already carried records; the two gaps
(`repo_settings`, `deleted_branches`) got their SPEC records this unit
(SPEC-0004 §3 item 6, SPEC-0008 §3.1 as-built) — no drift-extra: all 12
have live readers + a ground. Side finding: `lfs_locks.lower_path` — which
the census (§3.1) and §4 still call "unrecorded" — IS recorded (SPEC-0006
§2.7, LANDED 2026-10-30, migration 0045); those two cells are outside this
unit's ownership and await their owners.

Arithmetic: 95 upstream tables paired (one pair, `attachment`, splits into
two of ours; the `upload` pair shares `issue_attachments` with it) + 22
missing = 117 upstream. On our side: 95 distinct tables covered by the
pairs (the split adds `release_assets` beyond the 94 one-to-one names) +
12 extras = 107 definitions.

### 3.3 Missing tables — the no-reader arm, scrutinized (GS unit, 2026-11-03)

22 upstream tables have no counterpart. The census's quick "no reader"
verdict is upgraded below for the five tables the demand audit dispatched
(`user_open_id`, `team_invite`, `renamed_branch`, `commit_status_summary`,
`app_state`) — each verdict carries the four legs the FN-9 pattern fixed
(§7.11): the upstream model, the writer matrix, the reader matrix + the
user-visible surface it feeds, and our-surface demand. (The §3.1 reason
cells for these five keep the quick verdict; this section supersedes
them.) Dispatch material for the trigger-live ports: `/tmp/GS-port-plans.md`.

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
  arm ported as ours `deleted_branches`). (`app_state` was listed here
  before this scrutiny — moved below; its ground was wrong twice: upstream
  keeps NO cron bookkeeping in it, and ours `cron_state` is a per-arm tick
  ledger, not its substitute.)
- **Platform-adapted (the platform genuinely cannot / need not):**
  `dbfs_meta` + `dbfs_data` (R2 replaces dbfs; schema.ts:3906,4439),
  `system_setting` (SPEC-0018 §1-2: no app.ini, no runtime-writable
  settings store — config is wrangler vars), `repo_archiver` (archives
  built on demand and streamed; SPEC-0004 §2.4, `api/services/archive.ts`),
  `language_stat` (on-demand extension-sum reduction; SPEC-0004 divergence
  note, `api/services/languages.ts:1-15`), `repo_indexer_status`
  (indexer-class store DEFERRED with recorded reopen triggers; SPEC-0019).
- **The scrutinized five:**
  1. **`renamed_branch` — trigger LIVE (hard: a user-visible behavior
     gap).** Upstream model `RenamedBranch` (models/git/branch.go:293-299:
     id pk autoincr, repo_id INDEX NOT NULL, `from`, `to`,
     created_unix). WRITERS: one — RenameBranch's step-5 insert
     (models/git/branch.go:407-413) inside the rename tx, after the ref
     flip, the default-branch fixup (:353-361), the protected-rule rename
     (:363-390) and the open-PR base/head walks (:392-405); plus the
     repo-delete cleanup (services/repository/delete.go:164). READERS:
     one — FindRenamedBranch (models/git/branch.go:302-304), called from
     the ref-resolution walk (services/context/repo.go:882-895): a URL
     naming a dead branch that matches a rename's from-name resolves, and
     the context REDIRECTS to the new name with the
     `repo.branch.renamed` flash (services/context/repo.go:1006-1016).
     Surface: deep-link continuity after a branch rename — old
     `/src/branch/{old}/...` links keep working. OUR SURFACE: the rename
     feature EXISTS on both arms — the API
     `PATCH /repos/{owner}/{repo}/branches/{branch}`
     (`api/routes/branches.ts:725-860` — gates, CAS ref flip, default
     fixup, webhook pair) and the UI
     `POST /{owner}/{repo}/branches/rename` (`ui/index.ts:9287-9345`,
     route :19915) — but neither persists a rename log, and the legacy-ref
     walk omits upstream's renamed arm (`ui/pages/raw-files.ts:94-95`,
     recorded at landing). THE PRECISION (FY3's review, at the freeze): the
     TYPED shape `/src/branch/{old}` 404s in ours (resolveRefSuffix
     returns null -> the notFound shell, ui/index.ts:7020-7027 +
     file-view.tsx:279-280) — no wrong content; the default-branch
     wrong-content fallback bites only the LEGACY raw/media arm
     (resolveLegacyRefSuffix, raw-files.ts:212-229, which ports
     upstream's getRefNameLegacy INCLUDING its FIXME fallback
     repo.go:859-862 — upstream's legacy arm calls getRefName first and
     so would have redirected). Feature live + table
     serves it → the port-when-read trigger is LIVE, named: the legacy-ref
     redirect arm of the `/src` family (reader) riding the two landed
     rename writers.
  2. **`commit_status_summary` — trigger live (SOFT: a perf
     denormalization; the feature is already served).** Upstream model
     `CommitStatusSummary` (models/git/commit_status_summary.go:17-23:
     repo_id+sha UNIQUE(repo_id_sha), state VARCHAR(7) NOT NULL,
     target_url — the denormalized per-sha rollup). WRITERS: one —
     UpdateCommitStatusSummary (commit_status_summary.go:57-92), re-deriving
     CalcCommitStatus from the raw rows, in the SAME tx as every status
     create (services/repository/commitstatus/commitstatus.go:89-102).
     READERS: one — GetLatestCommitStatusForRepoAndSHAs
     (commit_status_summary.go:34-55), called only from
     FindReposLatestCommitStatuses (commitstatus.go:160) — the REPO-LIST
     badge feed (routers/web/repo/repo.go:523 SearchRepo → the
     dashboard/repo-picker `latest_commit_status`). NOT the PR rollup:
     upstream's PR merge box, commit pages and gitgraph compute from the
     RAW `commit_status` rows too (routers/web/repo/pull.go:414,
     view.go:142, commit.go:386; services/pull/commit_status.go:142,
     pull.go:940) — the brief's "PR commit-status rollup" hypothesis is
     refuted. And the reader DEGRADES GRACEFULLY: missing summary rows
     fall to the raw per-sha aggregation + CalcCommitStatus
     (commitstatus.go:186-202) — the table is a read optimization under
     the 3-day cache (commitstatus.go:59), optional for correctness.
     OUR SURFACE: the badge feature EXISTS — `/repo/search` renders
     `latest_commit_status` (`ui/pages/search-aux.ts:57-70`) via the
     on-the-fly rollup (`calcCommitStatusShell` :441-470 over
     `combineCommitStatusStates`, `api/services/commit-status.ts:244-270`)
     — ours runs upstream's own fallback path verbatim, wire-identical.
     Verdict: trigger LIVE, named: the `/repo/search`
     `latest_commit_status` read — but the port would be a
     denormalization, not a feature unlock; LOW priority, queue only if
     the raw aggregation over a repo page shows D1 cost.
  3. **`team_invite` — recorded-absent candidate (the invite feature is
     not ported; the reduction is recorded at both arms).** Upstream
     model `TeamInvite` (models/organization/team_invite.go:73-82: token
     UNIQUE(token), inviter_id, org_id INDEX, team_id+email
     UNIQUE(team_mail), created/updated_unix). WRITERS: CreateTeamInvite
     (:84-130 — duplicate + already-member-by-email guards, 25-char
     random token :119) from the team-members add-by-email arm
     (routers/web/org/teams.go:171-194, write :177, gated on
     `MailService != nil`); RemoveInviteByID (:132-138) from the
     remove_invite arm (teams.go:215-222) and the accept POST (:621);
     cascade deletes on org delete (services/org/org.go:40) and team
     delete (services/org/team.go:221). READERS: GetInvitesByTeamID
     (:140-145) renders the members page's pending-invite list
     (teams.go:409-413, tplTeamMembers); GetInviteByToken (:147-158)
     powers the accept flow — GET+POST `/org/invite/{token}`
     (routers/web/web.go:974-979; render teams.go:582-602, POST =
     AddTeamMember by ctx.Doer + remove invite + redirect to the team
     page, teams.go:605-626); MailTeamInvite mails the token link
     (services/mailer/mail_team_invite.go:24-45, template
     `mail/org/team_invite`, itself gated on MailService). Surface: the
     email-invite + accept flow and the pending-invite UI. OUR SURFACE:
     the team-members feature EXISTS (join/leave/add/remove landed,
     `ui/index.ts:14452-14508`) but both invite arms are deliberately
     reduced dead code — the add-by-email arm is unreachable ("at this
     pin there is no MailService, so the email-invite branch upstream
     guards on `setting.MailService != nil` is dead",
     `ui/index.ts:14422-14436,14491-14494`) and remove_invite reduces to
     the team-page redirect (:14500-14505); the team-delete cascade
     records `team_invite` as a still-unmodeled upstream cleanup
     (`api/routes/org-teams.ts:607-608`). No accept route, no
     pending-invite UI, no store. Verdict: recorded-absent candidate —
     no feature, parity holds trivially (no invites can exist). Named
     reopen trigger: the SPEC that first ports upstream's invite branch
     (teams.go:171-194) — ours has the outbound-mail substrate
     (`email_outbox`, SPEC email-outbound; schema.ts:4664) but no
     MailService gate wired to team flows; that SPEC owns the table port
     (invite CRUD + token accept + the deleteTeam cascade + the mailer
     arm).
  4. **`user_open_id` — recorded-absent candidate (no OpenID-2.0 identity
     surface).** Upstream model `UserOpenID` (models/user/openid.go:18-23:
     uid INDEX NOT NULL, uri UNIQUE NOT NULL, show DEFAULT false).
     WRITERS: settings add (routers/web/user/setting/security/openid.go:112),
     delete (:146, id+uid-guarded via GetUserOpenIDByID :136), visibility
     toggle (:170); the signin-connect arm (routers/web/auth/openid.go:315-317
     — an existing user attaches a verified OpenID after a password
     check), the signup arm (auth/openid.go:401-403 — registration adds
     the URI), the post-2FA pending-URI attach (auth/openid.go:44-57,
     write :51); the uniqueness guard isOpenIDUsed
     (models/user/openid.go:43-49, enforced in AddUserOpenID :72-81); the
     user-deletion cleanup (services/user/delete.go:85). READERS:
     GetUserByOpenID (models/user/user.go:1424-1438) — sign-in by OpenID
     URI (auth/openid.go:174, signInOpenIDVerify); GetUserOpenIDs — the
     profile big-avatar URI list (routers/web/shared/user/header.go:35-41;
     template templates/shared/user/profile_big_avatar.tmpl:81-88,
     Show=true only) and the settings Security → Manage OpenID list
     (setting/security/security.go:157, openid.go:61-63; template
     templates/user/settings/security/openid.tmpl:9). Surface: OpenID
     sign-in, profile OpenID identities, settings management. OUR
     SURFACE: none of the three — the identity surface is grep 0; our
     "openid" hits are different protocol surfaces (the OIDC auth-source
     client — SPEC external-auth-sources; the goth provider key
     `openidConnect`, schema.ts:4982; the webfinger openid-connect issuer
     rel, `services/federation/webfinger.ts:273`) — external-provider
     SSO, not self-hosted OpenID identities. Verdict: recorded-absent
     candidate — no feature on any arm; parity holds trivially. Named
     reopen trigger: an OpenID-2.0 identity SPEC (sign-in and/or
     profile-list scope) — it owns the table port.
  5. **`app_state` — recorded-absent candidate (generic singleton KV; both
     upstream consumers platform-absent).** Upstream model `AppState`
     (models/system/appstate.go:17-21: id string pk varchar(200),
     revision, content LONGTEXT — JSON per key, revision the optimistic
     counter). WRITER/READER pair: SaveAppStateContent / GetAppStateContent
     (models/system/appstate.go:28-45 / :48-56) behind the DBStore
     StateStore (modules/system/db.go:15-36; `AppState = &DBStore{}`,
     modules/system/appstate.go:23-25). Exactly TWO state items exist at
     the pin: CheckerState (modules/updatechecker/update_checker.go:20-26;
     Set :67, Get :73 — the latest version the admin dashboard update
     notice reads, GetNeedUpdate :80) and RuntimeState
     (routers/init.go:77-102 syncAppConfForGit — LastAppPath/LastCustomConf;
     a change re-syncs repository hooks and rewrites SSH public keys).
     Surface: the admin dashboard "a new Gitea version is available"
     notice. OUR SURFACE: the notice feature is absent (grep 0 over the
     admin UI), and the RuntimeState consumer is platform-absent (no
     on-disk hooks to re-sync, no SSH keys to rewrite, config is static
     wrangler vars rather than files); our singleton-state needs are
     served by purpose-built tables (`system_keystore` for key material,
     `cron_state` for tick bookkeeping — schema.ts:4593/4714), which are
     NOT app_state substitutes, just its only plausible demands already
     answered differently. Verdict: recorded-absent candidate — no
     feature. Named reopen trigger: the first feature needing persisted
     singleton system state (an update-checker, an install/migration-state
     flag) — that SPEC ports app_state's shape or records a purpose-built
     substitute.
- **`gpg_key_import`** stays recorded-absent as before (schema.ts:2272-2273,2366
  — armor not kept, a deliberate reduction rather than a pending reader).

Queue the trigger-live tables as their own migration + SPEC at the named
triggers (`renamed_branch` now, `commit_status_summary` opportunistically);
the candidates' named triggers own their ports the same way (the ADR-0007
grant applies when that day comes).

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

26 subsections: the 25 tables the census classed drift + `repositories`
(verdict intentional-recorded with a flagged residual). Three of the 25
(`review`, `reaction`, `release`) were later reclassified
intentional-recorded by §7.11 (their only drift was the original_author
family; the cite-audit propagated the flip) — their subsections remain as
the recorded-absent census. Within each, blanket-family
renames (created_at/updated_at, uid→user_id) are excluded; explicit RENAME
lines are table-specific name-only divergences; MISSING/OURS-EXTRA/TYPE
lines are structural. Both-side cites on every line.

### `comment` → `comments` schema.ts:740

upstream: models/issues/comment.go (struct `Comment`)

**FN-2 derivation expansion (unit GJ, 2026-11-03, pin `fc4936884584`; this
unit owns this entry's cells).** Erratum to the census cells first:
**upstream has no `patch_quoted` column.** The Go field `PatchQuoted`
carries the xorm column-name override `xorm:"LONGTEXT patch"`
(models/issues/comment.go:330 — bare-token column rename, same convention
as `Issue.Title xorm:"name"`, issue.go:63), so the persisted column is
literally `patch`; the runtime `Patch` field is `xorm:"-"` (comment.go:329,
never stored — BeforeInsert/BeforeUpdate copy Patch→PatchQuoted with an
invalid-UTF-8 `strconv.Quote` guard, comment.go:402-415, and AfterLoad
unquotes, :418-426). Ours `comments.patch` (schema.ts:763) IS that column:
the pair "MISSING `patch_quoted`" + "OURS-EXTRA `patch`" below collapses to
**PARITY** (name and content family both match; ours stores the raw engine
diff — the quote guard is a no-op for valid UTF-8, which is the only
divergence arm and it is unobserved). The §3.1 `comment` row's reason
inherits this correction: FN-2 adds **7 columns, not 8** — the audit's
"8 mutation-metadata cols" figure counts `patch_quoted`, which does not
exist as a column. Verdict matrix and derivation follow.

Verdict matrix (ADR-0007 vocabulary; ours cites = this worktree):

| upstream column | upstream field (cite) | our write seam today | our read arm today | verdict |
|---|---|---|---|---|
| `project_id` | `ProjectID int64` nullable (comment.go:292) | LANDED (FN-2) — the type-30/31 writers stamp the column with `content` empty (api/services/projects.ts, api/services/issues.ts; SPEC-0005 §7.3 as-built); the pre-port JSON-in-content rows are backfilled by 0067 | LANDED — the timeline render reads the column (the `project_id: 0` hardcode gone, api/services/issues.ts) | drift → LANDED (FN-2, 2026-11-03) |
| `old_project_id` | `OldProjectID int64` nullable (comment.go:291) | LANDED (FN-2) — same arms, the add/remove id pair per issue_project.go:90-99/:138-147 | LANDED — the timeline render reads the column | drift → LANDED (FN-2, 2026-11-03) |
| `time_id` | `TimeID int64` nullable (comment.go:301) | LANDED (FN-2) — the add/stop writers stamp the exact-row link in all four twins (the trackedTimes insert runs alone, then the comment batch — a drizzle batch leg cannot reference a prior leg's returning id); 0067 backfilled the pre-port rows via the documented correlation | LANDED — `trackedTimeOfComment` reads `time_id` FIRST, the (poster, seconds, second) correlation is the legacy-row fallback only (its docstring is the removal marker) | drift → LANDED (FN-2, 2026-11-03) |
| `assignee_team_id` | `AssigneeTeamID int64` NOT NULL DEFAULT 0 (comment.go:307) | LANDED (FN-2) — the team review-request arms stamp `assigneeTeamId = team.id` (api/routes/pull-reviews.ts, review.go:865/:922); 0067 backfilled the team rows from `pull_reviews.reviewer_team_id` | LANDED — the timeline renders the contract Team shape via the batched teams map (upstream ToTeam; a dangling id drops the row — LoadAssigneeUserAndTeam's error arm), the `assignee_team: null` hardcode gone | drift → LANDED (FN-2, 2026-11-03) |
| `comment_meta_data` | `CommentMetaData *CommentMetaData` JSON TEXT nullable (comment.go:360, struct :249-257) | PARTIAL — type-31 column-move payload rides `content` JSON (projects.ts:1060); no CODEOWNERS arm; workflows reuse the human write (services/projects-workflow.ts:510-560) | none — no type-31/label timeline render (ui/pages/issue-detail.tsx:734-746 renders types 0/1/2/28 only), no label-merge guard | drift → PORT the column-move arm; SpecialDoerName arms PORT-WHEN-READ |
| `original_author` | `OriginalAuthor string` nullable (comment.go:280) | none — no comment-migration inflow (grep 0) | none — API `user` renders the poster row directly (issues.ts:1417), no `ToAuthor` fallback | recorded-absent (FN-9, §7.11 + SPEC-0005 §9; the `issues.original_author` twin is RESERVED, schema.ts:620) |
| `original_author_id` | `OriginalAuthorID int64` nullable (comment.go:281) | none | none | recorded-absent (FN-9, §7.11) |
| (`patch`) | `PatchQuoted string xorm:"LONGTEXT patch"` (comment.go:330) | LIVE — code-comment create + reply write it (api/routes/pull-reviews.ts:1013; api/routes/repo-extras-t2.ts:1509) | LIVE — diff-hunk render (pull-reviews.ts:506) | PARITY (erratum above) |

The derivation, column by column (upstream write/read cites verified at the
pin):

- `project_id` / `old_project_id` — WRITE: the type-30 project comments.
  Remove arm `OldProjectID: projectID, ProjectID: 0`
  (models/issues/issue_project.go:90-99, cells :95-96); add arm
  `OldProjectID: 0, ProjectID: projectID` (:138-147, cells :143-144);
  `CreateComment` copies the opts verbatim (comment.go:882-883). READ:
  `LoadProject` (comment.go:594-607) from the web timeline
  (routers/web/repo/issue_view.go:735-752); the type-30 template arm
  branches `gt .OldProjectID 0` / `gt .ProjectID 0`
  (templates/repo/issue/view_content/comments.tmpl:565-576); and
  `ToTimelineComment` emits both
  (services/convert/issue_comment.go:97-98 → contract
  `old_project_id`/`project_id`, modules/structs/issue_comment.go:68-69).
  Our writers exist and store the same VALUES in content JSON
  (api/services/projects.ts:914 `{old_project_id:0, project_id}`,
  :967 `{old_project_id, project_id:0}`; api/services/issues.ts:2258-2266
  mirrors the shape) — the port moves the values into the columns and
  empties `content` (upstream's type-30/31 content is empty: the
  CreateCommentOptions pass no Content), backfilling stored rows from
  their JSON (SPEC-0005 §7 PLAN).
- `time_id` — WRITE: add-time-manual (models/issues/tracked_time.go:180-189,
  cell :188) and stop-tracking (models/issues/stopwatch.go:156-164, cell
  :162) ONLY; the delete/start/cancel arms set none (tracked_time.go:256-263,
  :280-287; stopwatch.go:194-201, :222-230). READ: `LoadTime`
  (comment.go:732-739) → `ToTimelineComment`'s `tracked_time`
  (services/convert/issue_comment.go:58-62,121-129) and the delete-time
  template's link (templates/repo/issue/view_content/
  comments_delete_time.tmpl:6). Our writers omit the column and the reader
  is the documented heuristic correlation (api/services/issues.ts:1183-1196
  docstring; :1207 `trackedTimeOfComment`) — the port writes `time_id` in
  the same batch at both writer pairs and retires the heuristic for new
  rows; legacy-row backfill rides the heuristic's own correlation.
- `assignee_team_id` — WRITE: the team review-request add/remove comments
  (models/issues/review.go:859-869, cell :865; :916-928, cell :922 — the
  `NOT NULL DEFAULT 0` tag at comment.go:307). READ:
  `LoadAssigneeUserAndTeam` (comment.go:686-700) → `ToTimelineComment`'s
  `assignee_team` (services/convert/issue_comment.go:40-44,179-181 →
  contract modules/structs/issue_comment.go:89-90) and the timeline text
  (comment.go:821-845 `TimelineRequestedReviewTr`). Our team arms exist
  and write type-27 comments WITHOUT the column
  (api/routes/pull-reviews.ts:1596-1602, :1699-1706) — the port stamps it
  in both arms; the API render stops being hardcoded null (issues.ts:1437).
- `comment_meta_data` — WRITE: `buildCreateCommentMetaData`
  (comment.go:847-864) fills it from (a) the type-31 column-move opts
  (services/projects/issue.go:180-191), (b) CODEOWNERS review requests
  (models/issues/review.go:756, :867), (c) project-workflow-triggered
  comments via the ctx carrier (comment.go:261-266, consumed :849-851;
  services/projects/workflow_notifier.go:145). READ: the type-31 template
  arm (templates/repo/issue/view_content/comments.tmpl:578-591 —
  `CommentMetaData.ProjectColumnTitle`/`ProjectTitle` + `LoadProject`),
  `MetaSpecialDoerTr` author attribution (comment.go:806-819;
  templates/repo/issue/view_content/comments_authorlink.tmpl:10-14), and
  the label-comment merge guard (routers/web/repo/issue_view.go:221-223,
  guard call :236 — `sameCommentMetaData`; workflow label comments must
  not merge with manual ones). Our live arm is only (a), encoded in content JSON
  (api/services/projects.ts:1060); (b) has no surface (no CODEOWNERS arm,
  grep 0) and (c) routes through the human write path
  (services/projects-workflow.ts:510-560) with no metadata. Verdict: the
  column-move arm ports with type-31 (the column stores the struct's JSON,
  so the content→column move is mechanical); the SpecialDoerName arms
  queue port-when-read — no reader arms exist here (the UI renders no
  label or type-31 events this wave, ui/pages/issue-detail.tsx:734-746).
- `original_author` / `original_author_id` — WRITE: solely the migration
  uploader's `RemapExternalUser` (comment.go:1279-1283, reached from
  services/migrations/gitea_uploader.go:1010-1026 when the source user
  cannot be mapped; the same flow's code comments carry `Patch`,
  gitea_uploader.go:940-963, cell :958). READ: `ToAuthor`'s ghost-author
  fallback (services/convert/user.go:53-58, fed at
  services/convert/issue_comment.go:21,89), the migrated-author template
  (templates/repo/issue/view_content/comments_authorlink.tmpl:1-8; avatar
  gate comments_avatarlink.tmpl:1), `roleDescriptor`'s
  `HasOriginalAuthor` arm (comment.go:1295-1298;
  routers/web/repo/issue_view.go:47-49,708,808), and the label-merge
  poster guard (issue_view.go:234). No writer and no reader arm exists
  here (no comment-migration inflow; `issues` already carries the twin
  columns unwritten, schema.ts:620-621). DISPOSITION (supersedes this
  entry's original port-when-read): recorded-absent by §7.11 + SPEC-0005
  §9 — the pair stays out of FN-2's migration; the importer SPEC owns it
  if that day comes.

Remaining structural cells (unchanged by this expansion):

- MISSING `assignee_team_id` (integer NOT NULL, DEFAULT 0) — upstream models/issues/comment.go:307 (`AssigneeTeamID`); resolved PORT above (census cite :308 corrected — the field sits at :307; same column `assignee_team_id` under GonicMapper)
- MISSING `comment_meta_data` (text(json)) — upstream models/issues/comment.go:360 (`CommentMetaData`); no ours column (census cite :361 off by one — :360 is the field, :361 is blank)
- MISSING `old_project_id` (integer) — upstream models/issues/comment.go:291 (`OldProjectID`); no ours column (census cite :292 off by one)
- MISSING `original_author` (text) — upstream models/issues/comment.go:280 (`OriginalAuthor`); no ours counterpart — recorded-absent (§7.11)
- MISSING `original_author_id` (integer) — upstream models/issues/comment.go:281 (`OriginalAuthorID`); no ours counterpart — recorded-absent (§7.11)
- MISSING `project_id` (integer) — upstream models/issues/comment.go:292 (`ProjectID`); no ours column (census cite :293 off by one)
- MISSING `time_id` (integer) — upstream models/issues/comment.go:301 (`TimeID`); no ours column (census cite :302 off by one)
- ~~MISSING `patch_quoted`~~ / ~~OURS-EXTRA `patch`~~ — ERRATUM: one parity column `patch` (schema.ts:763 ↔ comment.go:330's tag override); see the expansion header
- TYPE `removed_assignee`: upstream boolean (models/issues/comment.go:305) vs ours integer (schema.ts:752 (`comments`)) — the §2.4 blanket (storage-equal, cosmetic; census cite :306 corrected — the field sits at :305)

### `commit_status` → `commit_statuses` schema.ts:1256

upstream: models/git/commit_status.go (struct `CommitStatus`)

- MISSING `context_hash` (text(varchar64)) — upstream models/git/commit_status.go:50 (`ContextHash`); no ours counterpart. Semantics + port derived (§7.12): the sha1 dedupe key (`HashCommitStatusContext`, commit_status.go:550-552), default-derived from `Context` at write (:526-528) or pre-computed by the Actions caller with the workflow path mixed in (actions/commit_status.go:282, issue #35699); internal-only (no json tag — never rendered on the API or the webhook), its only observable is the latest-per-context grouping it keys (GetLatestCommitStatus :343-359, CountLatestCommitStatus :361-366, ForPairs :369-422, ForRepoCommitIDs :426-472)
- MISSING `index` (integer) — upstream models/git/commit_status.go:41 (`Index`); no ours counterpart. Semantics + port derived (§7.12): the per-(repo, sha) monotonic creation ordinal — the API `id` field carries it (services/convert/status.go:24 `ID: status.Index`), NOT the row pk; assigned inside the `NewCommitStatus` tx (:497-537) from the `commit_status_index` MAX+1 counter (:125-181, table :329-335)

### `gpg_key` → `gpg_keys` schema.ts:2373

upstream: models/asymkey/gpg_key.go (struct `GPGKey`)

- MISSING `emails` (text(json)) — upstream models/asymkey/gpg_key.go:33 (`Emails`); no ours counterpart

### `issue` → `issues` schema.ts:610

upstream: models/issues/issue.go (struct `Issue`)

- RENAME `name` → `title` (ours `issues`; schema.ts:624) — column-NAME tag, not mapper output: upstream `Title string xorm:"name"` (models/issues/issue.go:63) sets the SQL column to `name`, and upstream's own SQL binds that literal (title writes: `UpdateIssueCols(ctx, issue, "name")` inside ChangeIssueTitle, models/issues/issue_update.go:198; keyword search: `BuildCaseInsensitiveLike` over the backticked column, models/issues/issue.go:536) — name-only divergence; FN-5 carrier (§7.8)

### `issue_label` → `issue_labels` schema.ts:840

upstream: models/issues/issue_label.go (struct `IssueLabel`)

- MISSING `id` (integer) — upstream models/issues/issue_label.go:20 (`ID`); no ours counterpart

### `issue_pin` → `issue_pins` schema.ts:1093

upstream: models/issues/issue_pin.go (struct `IssuePin`)

- MISSING `id` (integer) — upstream models/issues/issue_pin.go:18 (`ID`); no ours counterpart
- MISSING `is_pull` (boolean NOT NULL) — upstream models/issues/issue_pin.go:21 (`IsPull`); no ours counterpart

### `issue_dependency` → `issue_dependency` schema.ts:1885

upstream: models/issues/dependency.go (struct `IssueDependency`)

- MISSING `updated_unix` (integer) — upstream models/issues/dependency.go:107 (`UpdatedUnix`); no ours counterpart

### `tracked_time` → `tracked_time` schema.ts:1913

upstream: models/issues/tracked_time.go (struct `TrackedTime`)

- RENAME `time` → `seconds` (ours `tracked_time`; schema.ts:1920) — rename; unit stays seconds upstream API json "time" is seconds too (modules/structs)

### `review` → `pull_reviews` schema.ts:2438

upstream: models/issues/review.go (struct `Review`) — table verdict
intentional-recorded (reclassified by §7.11 + SPEC-0005 §9: this family
was the table's ONLY drift; the cite-audit propagated the flip)

- MISSING `original_author` (text) — upstream models/issues/review.go:130 (`OriginalAuthor`); no ours counterpart — recorded-absent (§7.11)
- MISSING `original_author_id` (integer) — upstream models/issues/review.go:131 (`OriginalAuthorID`); no ours counterpart — recorded-absent (§7.11)

### `reaction` → `reactions` schema.ts:894

upstream: models/issues/reaction.go (struct `Reaction`) — table verdict
intentional-recorded (reclassified by §7.11 + SPEC-0005 §9: this family
was the table's ONLY drift; the cite-audit propagated the flip)

- MISSING `original_author` (text NOT NULL) — upstream models/issues/reaction.go:70 (`OriginalAuthor`); no ours counterpart — recorded-absent (§7.11)
- MISSING `original_author_id` (integer NOT NULL) — upstream models/issues/reaction.go:69 (`OriginalAuthorID`); no ours counterpart — recorded-absent (§7.11)

### `release` → `releases` schema.ts:930

upstream: models/repo/release.go (struct `Release`) — table verdict
intentional-recorded (reclassified by §7.11 + SPEC-0005 §9: this family
was the table's ONLY drift; the cite-audit propagated the flip)

- MISSING `original_author` (text) — upstream models/repo/release.go:74 (`OriginalAuthor`); no ours counterpart — recorded-absent (§7.11)
- MISSING `original_author_id` (integer) — upstream models/repo/release.go:75 (`OriginalAuthorID`); no ours counterpart — recorded-absent (§7.11)

### `review_state` → `review_state` schema.ts:4965

upstream: models/pull/review_state.go (struct `ReviewState`) — the updated_files
line below LANDED by FN-3 (2026-11-03, migration 0065; `updated_files` TEXT NOT
NULL DEFAULT '{}', the numeric ViewedState JSON; `specs/table-alignment-fn3-review-state.md`)

- RENAME `pull_id` → `issue_id` (ours `review_state`; schema.ts:4971) — NAME + VALUE-SPACE: upstream pull_id = pull_request.id (gitdiff.go:1513 passes pull.ID); ours issue_id = issues.id (1:1 rows, but the stored id space differs)
- MISSING `updated_files` (text(json) NOT NULL) — upstream models/pull/review_state.go:46 (`UpdatedFiles`); no ours counterpart — **LANDED by FN-3**

### `pull_auto_merge` → `pull_auto_merges` schema.ts:4989

upstream: models/pull/automerge.go (struct `AutoMerge`)

- RENAME `message` → `merge_message` (ours `pull_auto_merges`; schema.ts:5004) — rename-only divergence (name, not semantics)
- RENAME `pull_id` → `issue_id` (ours `pull_auto_merges`; schema.ts:4994) — NAME + VALUE-SPACE: upstream pull_id = pull_request.id (gitdiff.go:1513 passes pull.ID); ours issue_id = issues.id (1:1 rows, but the stored id space differs)
- MISSING `merged_commit_id` (text(varchar64)) — upstream models/pull/automerge.go:26 (`MergedCommitID`); no ours counterpart
- OURS-EXTRA `sha` — schema.ts:4998 (`pull_auto_merges.sha`)

### `protected_branch` → `protected_branches` schema.ts:2485

upstream: models/git/protected_branch.go (struct `ProtectedBranch`)

- RENAME `branch_name` → `rule_name` (ours `protected_branches`; schema.ts:2495) — rename-only divergence (name, not semantics)
- RENAME `config` → `rules` (ours `protected_branches`; schema.ts:2501) — rename-only divergence (name, not semantics)

### `protected_tag` → `protected_tags` schema.ts:3120

upstream: models/git/protected_tag.go (struct `ProtectedTag`)

- RENAME `allowlist_team_i_ds` → `allowlist_team_ids` (ours `protected_tags`; schema.ts:3133) — rename-only divergence (name, not semantics)
- RENAME `allowlist_user_i_ds` → `allowlist_user_ids` (ours `protected_tags`; schema.ts:3131) — rename-only divergence (name, not semantics)

### `package_blob_upload` → `package_blob_uploads` schema.ts:3837

upstream: models/packages/package_blob_upload.go (struct `PackageBlobUpload`)

- MISSING `hash_state_bytes` (blob) — upstream models/packages/package_blob_upload.go:27 (`HashStateBytes`); no ours counterpart
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
- MISSING `recipient_access_granted` (boolean NOT NULL, DEFAULT false) — upstream models/repo/transfer.go:75 (`RecipientAccessGranted`); no ours counterpart
- MISSING `updated_unix` (integer NOT NULL) — upstream models/repo/transfer.go:78 (`UpdatedUnix`); no ours counterpart

### `repo_unit` → `repo_units` schema.ts:341

upstream: models/repo/repo_unit.go (struct `RepoUnit`) — all three MISSING
lines below LANDED by FN-6 (2026-11-03, migration
`0066_repo-unit-parity-columns.sql`; the SPEC record is the SPEC-0003 §3.1
as-built block)

- MISSING `created_unix` (integer) — upstream models/repo/repo_unit.go:47 (`CreatedUnix`, xorm `INDEX CREATED`; the audit's :48 was off by one) — **LANDED by FN-6**: nullable INTEGER (the ALTER-ADD-COLUMN non-constant-default constraint), stamped by the writers (repos/service.ts create seed; the settings toggles' stamps recorded — GE's in-flight file), 0066 backfills the carried rows from the parent repositories.created_at
- MISSING `everyone_access_mode` (integer NOT NULL, DEFAULT 0) — upstream models/repo/repo_unit.go:49 (`EveryoneAccessMode`, upstream migration v1_22 v297; the audit's :50 was off by one) — **LANDED by FN-6** as the §2.3 TEXT enum `none|read|write` NOT NULL DEFAULT 'none' (= DEFAULT 0, AccessModeNone; `write` is upstream's real space — the wiki unit's everyone-write flip, public_access.go:42); NO writer and NO reader in our surface yet — port-when-read (SPEC-0003 §3.1 as-built cites upstream's flip arm PublicAccessPost, public_access.go:134-153, and the calculator's everyone ladder, repo_permission.go:231-234)
- MISSING `id` (integer) — upstream models/repo/repo_unit.go:43 (`ID`; the audit's :44 was off by one) — **LANDED by FN-6** as the INTEGER autoincrement pk (the audit §2.1 non-referencing-pk family — same family as upstream's pk autoincr, no drift; the id-family TEXT record does NOT reach it: this id references nothing); the natural (repo_id, type) pk — the table's pre-0066 key — became the uniqueIndex `repo_units_repo_type_uq`, ours-stricter than upstream's non-unique `INDEX(s)` (repo_unit.go:44-45) and the ON CONFLICT target every unit write arm upserts through
- TYPE `anonymous_access_mode`: upstream integer (models/repo/repo_unit.go:48) vs ours text (schema.ts:369 (`repo_units`)) — the §2.3 TEXT-enum blanket, recorded, stays
- TYPE `type`: upstream integer (models/repo/repo_unit.go:45) vs ours text (schema.ts:365 (`repo_units`)) — the §2.3 TEXT-enum blanket, recorded, stays

### `collaboration` → `repo_collaborators` schema.ts:1500

upstream: models/repo/collaboration.go (struct `Collaboration`)

- RENAME `created_unix` → `created_at` (ours `repo_collaborators`; schema.ts:1506) — rename-only divergence (name, not semantics)
- RENAME `updated_unix` → `updated_at` (ours `repo_collaborators`; schema.ts:1507) — rename-only divergence (name, not semantics)
- MISSING `id` (integer) — upstream models/repo/collaboration.go:21 (`ID`); no ours counterpart
- TYPE `mode`: upstream integer (models/repo/collaboration.go:24) vs ours text (schema.ts:1505 (`repo_collaborators`))

### `audit_event` → `audit_event` schema.ts:3517

upstream: models/audit/audit_event.go (struct `Event`)

- RENAME `timestamp_unix` → `created_unix` (ours `audit_event`; schema.ts:3552) — rename-only divergence (name, not semantics)
- TYPE `action`: upstream integer (models/audit/audit_event.go:24) vs ours text (schema.ts:3524 (`audit_event`))
- TYPE `origin`: upstream integer (models/audit/audit_event.go:33) vs ours text (schema.ts:3545 (`audit_event`))
- TYPE `scope_type`: upstream integer (models/audit/audit_event.go:31) vs ours text (schema.ts:3536 (`audit_event`))

### `pull_request` → `pull_requests` schema.ts:680

upstream: models/issues/pull.go (struct `PullRequest`)

- MISSING `changed_protected_files` (text(json)) — upstream models/issues/pull.go:128 (`ChangedProtectedFiles`); no ours counterpart
- MISSING `type` (integer) — upstream models/issues/pull.go:122 (`Type`); no ours counterpart
- OURS-EXTRA `head_sha` — schema.ts:699 (`pull_requests.headSha`)

### `lfs_lock` → `lfs_locks` schema.ts:1281

upstream: models/git/lfs_lock.go (struct `LFSLock`)

- RENAME `created` → `created_at` (ours `lfs_locks`; schema.ts:1294) — rename-only divergence (name, not semantics)
- OURS-EXTRA `lower_path` — schema.ts:1293 (`lfs_locks.lowerPath`)

### `repository` → `repositories` schema.ts:29

upstream: models/repo/repo.go (struct `Repository`) — table verdict
intentional-recorded (SPEC-0001 §4 core shape:
`repositories(id, storage_key, refs_version, backend='self-hosted')`, the
D1 sketch at SPEC-0001 §4's closing lines)

**FN-4 disposition expansion (unit GR, 2026-11-03, pin `fc4936884584`; this
unit owns these cells).** All 26 upstream cites re-verified at the pin
EXACT-LINE — no off-by-one, and no xorm column-name override anywhere in
the struct (all 46 tags are constraint tokens; every name below is a clean
GonicMapper derivation) — so none of the 26 is false drift at the cite
level. The census's MISSING list is exact-name-accurate, but four of the 26
are nevertheless COVERED by landed ours columns under different names and
two more ride standing SPEC records: the residual is NOT 26 port columns.
The split: **18 drift ports + 4 standing-record folds + 4 staged-record
folds** (matrix below; FN-4's own "ours folds these into
visibility/fork_parent" note anticipated the folds). The staged records
live in the addendum draft `/tmp/GR-spec0001-repositories-addendum.md` —
the FN-4 port unit applies it as the SPEC-0001 §4 as-built block; the SPEC
flip is that unit's, not this derivation's.

Table 1 — the 26 MISSING upstream columns, dispositioned (upstream cites
pin-verified at `fc4936884584`; ours cites = this worktree):

| upstream column (upstream cite) | ours today | class (ADR-0007) | disposition |
|---|---|---|---|
| `archived_unix` — `ArchivedUnix timeutil.TimeStamp xorm:"DEFAULT 0"` (repo.go:220) | none — `is_archived` bool carries no timestamp (schema.ts:53) | drift | PORT — INTEGER DEFAULT 0 (constant, ALTER-legal); writer rides the archive-toggle arm (SPEC-0003 §2.4 row 10) |
| `avatar` — `Avatar string xorm:"VARCHAR(64)"` (repo.go:216; the avatar KEY — bytes live in storage) | none — API renders `avatar_url: ""` (repository.ts:930) | drift | PORT — TEXT nullable; writer = repo-avatar upload arm port-when-read (upstream services/repository/avatar.go:24-37) |
| `created_unix` — `CreatedUnix timeutil.TimeStamp xorm:"INDEX created"` (repo.go:218) | COVERED — `created_at` (schema.ts:79-81) | intentional-recorded | NO PORT — SPEC-0005 §3.2 as-built item 2 names `repositories` in the recorded `*_at` exception; SPEC-0003 §3.1:481 records the timestamps row; the §7.2 knock-on already superseded this arm |
| `default_wiki_branch` — `DefaultWikiBranch string` (repo.go:165; set at create.go:148 / migrate.go:113; fallback :309-310) | none | drift | PORT — TEXT nullable; writer = create seed + wiki init; reader = wiki surfaces port-when-read (SPEC wiki.md) |
| `description` — `Description string xorm:"TEXT"` (repo.go:160) | none as column — the VALUE lives in `repo_settings` (schema.ts:1601), rendered `settings?.description ?? ""` with the port TODO (repository.ts:821) | drift | PORT — TEXT nullable + data backfill FROM repo_settings + reader flip; API-visible |
| `fork_id` — `ForkID int64 xorm:"INDEX"` (repo.go:199) | COVERED — `fork_parent` TEXT (schema.ts:101; index :251) | intentional-recorded | NO PORT — the fold is recorded at SPEC-0001b §5.2 ("fork lineage is metadata only, D1 fork_parent-style column"); the TEXT-ness inherits the id-family record (ADR-0007 item 2, §2.1/§7.4) |
| `git_size` — `GitSize int64 xorm:"NOT NULL DEFAULT 0"` (repo.go:204) | none — `size_kb` is the GIT footprint only (schema.ts:133-145) | drift | PORT — INTEGER NOT NULL DEFAULT 0; writer = repo-size accounting split (0 until the next settle leg, the size_kb posture) |
| `is_fork` — `IsFork bool xorm:"INDEX NOT NULL DEFAULT false"` (repo.go:198) | COVERED-derivable — `fork_parent IS NOT NULL`; the API `fork` reader already derives it (repository.ts:830-835, citing upstream convert :208) | drift (fix = record, not DDL) | NO PORT — one nullable edge column stands for the pair; adding the bool would duplicate state (AGENTS.md) — RECORD staged (addendum §A.2; today no spec records the fold — FN-4's "record-or-add" resolves to record) |
| `is_fsck_enabled` — `IsFsckEnabled bool xorm:"NOT NULL DEFAULT true"` (repo.go:208) | none | drift | PORT — BOOLEAN NOT NULL DEFAULT true (constant, ALTER-legal); writer = repo settings advanced arm; the fsck-cron reader is port-when-read |
| `is_private` — `IsPrivate bool xorm:"INDEX"` (repo.go:186) | COVERED — `visibility` enum public\|private (schema.ts:45); reader `private: row.visibility === "private"` (repository.ts:829) | intentional-recorded | NO PORT — SPEC-0004 §3 records the registry shape ("`storage_key`, `refs_version`, `visibility`"); bool→TEXT enum is the §2.3 convention. Erratum: SPEC-0003's `is_private` mentions (:155,:238,:362,:475) are stale sketch text — the port SPEC reconciles |
| `lfs_size` — `LFSSize int64 xorm:"NOT NULL DEFAULT 0"` (repo.go:205) | none | drift | PORT — INTEGER NOT NULL DEFAULT 0; writer = repo-size LFS leg |
| `lower_name` — `LowerName string xorm:"UNIQUE(s) INDEX NOT NULL"` (repo.go:158) | COVERED — `slug` stored FOLDED (repos/service.ts:395,407 — `slug: lower`; resolution folds too, :376); `UNIQUE(owner_namespace, slug)` is the create/rename arbitration point (schema.ts:244-248) | drift (fix = record, not DDL) | NO PORT — duplicating lower_name beside a folded slug is state duplication — RECORD staged (addendum §A.2; SPEC-0003 §3.1's `name`/`lower_name` sketch rows (:474) are stale as-built) |
| `name` — `Name string xorm:"INDEX NOT NULL"` (repo.go:159; DISPLAY case) | none — ours keeps only the folded form and the API `name` renders it (`name: row.slug`, repository.ts:819) | drift | PORT — TEXT NOT NULL DEFAULT '' (constant, ALTER-legal); writers = create/rename stamp display case; backfill = slug copy (display case unrecoverable for existing rows — record the limitation); API-visible under the ADR-0002 freeze |
| `num_action_runs` — `NumActionRuns int xorm:"NOT NULL DEFAULT 0"` (repo.go:182) | none | drift | PORT — INTEGER NOT NULL DEFAULT 0; writer = upstream's recount shape (`UpdateRepoRunsNumbers` run.go:258-284: COUNT then `Cols(...)`) at the run create/finish settles (SPEC-0012 surface) |
| `num_closed_action_runs` — (repo.go:183) | none | drift | PORT — same batch and writer as num_action_runs |
| `num_closed_projects` — (repo.go:180) | none | drift | PORT — INTEGER NOT NULL DEFAULT 0; writer = projects create/close/delete arms (upstream project/project.go:282 increment, :362 recount) |
| `num_projects` — (repo.go:179) | none | drift | PORT — same batch and writer as num_closed_projects |
| `object_format_name` — `ObjectFormatName string xorm:"VARCHAR(6) NOT NULL DEFAULT 'sha1'"` (repo.go:211) | none as column — API renders the constant `"sha1"` (repository.ts:960); the engine is sha1-only (SPEC-0001 §5) | drift | PORT — TEXT NOT NULL DEFAULT 'sha1' (constant, ALTER-legal); writer = create seed; the reader already parity-renders |
| `original_service_type` — `OriginalServiceType api.GitServiceType xorm:"index"` (repo.go:162; writers create.go:237, adopt.go:58) | none (`original_url` is parity, schema.ts:116, SPEC-0009) | drift | PORT — TEXT enum nullable per the §2.3 convention (the FN-6 everyone_access_mode port precedent); writer rides the SPEC-0009 mirror/import create arm |
| `owner_name` — `OwnerName string` (repo.go:156; display case — create.go:231 `OwnerName: owner.Name`) | COVERED — `owner_namespace` (schema.ts:37; folded owner slug, kept in lockstep by the rename/transfer service) | drift (fix = record, not DDL) | NO PORT — same folded-value reduction as lower_name — RECORD staged (addendum §A.2) |
| `size` — `Size int64 xorm:"NOT NULL DEFAULT 0"` (repo.go:203; upstream scope = git + LFS, models/repo/update.go:110) | COVERED at a NARROWER scope — `size_kb` (schema.ts:145) is the git footprint only (the scope note, repository.ts:839-850) | drift (writer scope only — no new column) | PORT the WRITER SCOPE — size accounting widens to git+LFS riding the git_size/lfs_size leg (SPEC-0014 §5 owns the settle points); scope-parity record staged (addendum §A.2) |
| `template_id` — `TemplateID int64 xorm:"INDEX"` (repo.go:202; upstream READS :555,:835, WRITES never — grep 0 setters) | none (`is_template` is parity, schema.ts:126) | drift | PORT — INTEGER nullable + index; reader/writer port-when-read (upstream's own surface never writes it nonzero) |
| `topics` — `Topics []string xorm:"TEXT JSON"` (repo.go:210; the denormalized copy, maintained by `syncTopicsInRepository` off the topic/repo_topic JOIN, topic.go:340-352) | none as column — ours renders from `repo_topics` (repository.ts:618-622, :717-720) | drift | PORT — TEXT (JSON) nullable + data backfill = the recount (repo_topics JOIN — upstream's own shape) + hook the topic write arms + flip the reader |
| `trust_model` — `TrustModel TrustModelType` (repo.go:213; enum :101-108, 0 = default; writer setting/setting.go:723-725) | none | drift | PORT — TEXT enum nullable per §2.3; writer = repo signing-settings arm port-when-read |
| `updated_unix` — `UpdatedUnix timeutil.TimeStamp xorm:"INDEX updated"` (repo.go:219) | COVERED — `updated_at` (schema.ts:85) | intentional-recorded | NO PORT — same record as created_unix (SPEC-0005 §3.2 item 2 + SPEC-0003 §3.1:481) |
| `website` — `Website string xorm:"VARCHAR(2048)"` (repo.go:161) | none as column — VALUE in `repo_settings`, rendered `settings?.website ?? ""` with the port TODO (repository.ts:865) | drift | PORT — TEXT nullable + data backfill FROM repo_settings + reader flip; API-visible |

Table 2 — the OURS-EXTRA and TYPE/DEFAULT cells, dispositioned:

| ours cell (cite) | ground | disposition |
|---|---|---|
| OURS-EXTRA `backend` (schema.ts:62, default 'self-hosted') | intentional-recorded — SPEC-0001 §4 (`backend='self-hosted'`; ADR-0001 D1 adapter routing) | stands; no upstream counterpart |
| OURS-EXTRA `storage_key` (schema.ts:35, unique) | platform-adapted — R2 is the blob home and needs an explicit immutable key (SPEC-0001 §3 key layout, "renames never touch storage"; §4 references it); upstream derives paths from owner/name on a local disk | stands |
| OURS-EXTRA `refs_version` (schema.ts:60, default 0) | intentional-recorded — SPEC-0003 §3.1:480 (the denormalized DO mirror + its documented exception to no-duplicated-state) + SPEC-0001 §4/§5 (the edge-cache key, acceptance T4) | stands |
| OURS-EXTRA `owner_namespace` (schema.ts:37) | unrecorded today — the schema comment is the only record ("case-folded lookup key ... kept in lockstep by the rename/transfer service"); covers upstream `owner_name` | RECORD staged (addendum §A.2) |
| OURS-EXTRA `slug` (schema.ts:43) | unrecorded today — covers upstream `lower_name` (stored folded) and is the folded `name` carrier | RECORD staged (addendum §A.2) |
| OURS-EXTRA `visibility` (schema.ts:45) | intentional-recorded — SPEC-0004 §3 registry shape + §2.3 TEXT-enum convention; covers upstream `is_private` | stands |
| OURS-EXTRA `fork_parent` (schema.ts:101) | intentional-recorded — SPEC-0001b §5.2 + the TEXT id family (ADR-0007 item 2); covers upstream `fork_id` + `is_fork` | stands |
| OURS-EXTRA `size_kb` (schema.ts:145) | intentional-recorded — SPEC-0014 §5 (the size-observability row; settle-time maintained, services/repo-size.ts:146-159); covers upstream `size` at the narrower git-only scope | stands; the scope arm rides the sizes port (Table 1) |
| OURS-EXTRA `created_at` / `updated_at` (schema.ts:79,85) | intentional-recorded — SPEC-0003 §3.1:481 + SPEC-0005 §3.2 item 2 (`repositories` named in the `*_at` exception); cover upstream `created_unix`/`updated_unix` | stands |
| TYPE `close_issues_via_commit_in_any_branch` (repo.go:209 vs schema.ts:73-77) | NOT drift either way — ours is `integer({mode:"boolean"})`, storage-equal to upstream bool (§2.4 same family) | CELL WITHDRAWN as drift. Census-owner erratum: §2.4's bare-integer example list still names this column — stale (the mode wrapper is landed at schema.ts:73-77) |
| TYPE + DEFAULT `status` (repo.go:191 vs schema.ts:56-58) | intentional-recorded — §2.3 TEXT-enum convention; SPEC-0003 §3.1:478 records the TEXT status mirroring `RepositoryStatus`. The DEFAULT arm is NOT a divergence: upstream 0 = `RepositoryReady` (iota 0, repo.go:145) and ours 'ready' — the same value across the recorded encoding | the two rows collapse into one; stands |

Findings and false-drift flags (for the census owner — unacted here):

1. **No false drift among the 26 at the cite level** — every field
   verified at its exact line under the override rule; the section's
   upstream cites need no correction.
2. **The §2.4 boolean-storage example list is stale** for
   `repositories.close_issues_via_commit_in_any_branch` (mode wrapper
   landed, schema.ts:73-77) — a §2 edit, not this section's.
3. **schema.ts comment cite errata** (for whichever unit next touches the
   file — not edited by this unit): the `isTemplate` comment cites
   repo.go:190 (actual :201); the `status` comment cites repo.go:146-149
   (the const block is :144-149, `RepositoryReady` = iota 0 at :145).
4. **SPEC-0003 §3.1's sketch cells are stale as-built** (id "integer PK
   autoincrement" vs the TEXT id; `name`/`lower_name` vs slug;
   `is_private` vs visibility) — the addendum draft records the as-built
   shape; the port SPEC applies the reconciliation.
5. **The Headline and the §5 FN-4 bullet still say "26 columns"** — the
   split this unit derived is 18 port + 4 recorded-fold + 4
   staged-fold; the census owner folds the counts when it next sweeps.

FN-4 port decomposition (the recommended split; the ADR-0007 grant covers
the drift class):

- **One additive migration carries all 18 port columns.** Every add is
  ALTER-legal (constant DEFAULT or NULL; the one index add is a CREATE
  INDEX) — no pk/unique change, so NO table rebuild (unlike 0066).
  Columns: name, description, website, avatar, archived_unix,
  default_wiki_branch, git_size, is_fsck_enabled, lfs_size,
  num_action_runs, num_closed_action_runs, num_closed_projects,
  num_projects, object_format_name, original_service_type, template_id
  (+index), topics, trust_model.
- **Data backfills (real, upstream-shaped — ride the same migration):**
  topics ← repo_topics recount (the syncTopicsInRepository shape,
  topic.go:340-352); description + website ← repo_settings rows (today's
  value source, repository.ts:821/:865); name ← slug copy (display case
  unrecoverable — record the limitation). The counters and sizes stay 0
  (constant DEFAULT = the one-time settle posture; the num_stars
  precedent, schema.ts:152-168).
- **Writer legs split by surface owner (code, not DDL):**
  (a) identity/edit leg — name/description/website writers (create seed,
  rename arm, repo-edit route) + the convert reader flip off
  repo_settings; API-visible, rides ADR-0002 review; (b) counters leg —
  projects arms (num_projects/num_closed_projects) + actions arms
  (num_action_runs/num_closed_action_runs, the recount shape); (c) sizes
  leg — repo-size git/LFS split AND the `size` scope widening to git+LFS
  (update.go:110) at SPEC-0014's settle points; (d) long-tail leg —
  archived_unix stamp on the archive toggle, object_format_name +
  default_wiki_branch in the create seed, is_fsck_enabled/trust_model/
  original_service_type/template_id port-when-read arms as their surfaces
  land.
- **Record-only arms (no DDL):** the four staged folds (lower_name,
  owner_name, is_fork, size-scope) + the ours-extras slug/owner_namespace
  land via the SPEC addendum (staged at
  /tmp/GR-spec0001-repositories-addendum.md) — the FN-4 port unit applies
  it; created_unix/updated_unix/fork_id/is_private need no new record
  (their standing cites are in Tables 1/2).

**FN-4 LANDING (unit FN-4, 2026-11-03, migration
`0068_repositories-port-columns`) — the disposition above is EXECUTED; this
section's Tables 1/2 stay the derivation record, SPEC-0001 §4.1 is the
as-built record of record.** Landing notes over the matrix (each applied,
not re-derived): (1) all 18 columns landed in the one additive migration
with the three real backfills; (2) `template_id` landed TEXT (+ index) per
the id-family extension rule (ADR-0007 item 2 / §7.4) — a shape correction
over Table 1's INTEGER cell, recorded in the SPEC's landed block; (3)
description/website landed NULLable per the matrix, the repo_settings
columns retired in place (neither read nor written; the interface fields
dropped) rather than dropped by a second rebuild; (4) the readers flipped
with the writers (the convert renders name/description/website/topics/
archived_at/avatar_url/object_format_name from the row — the topics half of
parity item 3 CLOSES, the archived_at placeholder render replaced by
AsTime(0)'s epoch render); (5) the fork/generate/migrate create arms ride
the same columns (description copy, 'git' service type); (6) the
staged-addendum folds + the errata list are applied (isTemplate :190→:201
fixed in schema.ts; status left exact — DISPROVEN; adopt.go :58 re-verified
EXACT at port time).

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
- **FN-3: review_state.updated_files — the per-file viewed map.**
  **STATUS: LANDED (2026-11-03, migration `0065_review-state-updated-files`
  + `specs/table-alignment-fn3-review-state.md` — the rest of this row is
  the original scope, kept for the cites; the §3.1 row and the §4
  review_state section carry the LANDED annotations).** Upstream
  stores the whole (path → viewed-state) map per (user, pull)
  (`models/pull/review_state.go:46`, LONGTEXT JSON NOT NULL; rendered by
  `routers/web/repo/pull.go:853 filesViewedState = reviewState.UpdatedFiles`); ours had
  landed a REDUCTION — one sha cursor per (user, issue), the whole-PR mark.
  API/UI-visible: upstream's per-file viewed checkboxes degraded to a
  whole-PR toggle on ours. LANDED AS: the `updated_files` TEXT NOT NULL
  DEFAULT '{}' column (upstream's numeric ViewedState JSON verbatim; the
  default is the house back-fill for the cursor rows); the write arm
  (`updateViewedFilesFromWeb`) stores upstream's exact per-file entries —
  Go-strict decode (non-bool/non-string → 400), bool → Viewed/Unviewed,
  same-sha posts merge per-key (mergeFiles, review_state.go:117-126), a
  DIFFERENT sha inherits the stored map then merges and advances the cursor
  (the single-row mapping of getNewestReviewStateApartFrom's seeding
  :93-98; the pull_id value-space move stayed optional-unrecorded —
  issues.id works while the rows stay 1:1), and the old whole-PR row-delete
  is gone (uncheck writes UNVIEWED entries; the no-JS form arm expands to
  the diff's full path set); the read arm resolves upstream's ladder
  (gitdiff.go:1541-1555) per rendered file — stored Viewed degrades to
  has-changed when the file changed between the cursor sha and the head
  (GetFilesChangedBetween via the engine's readDiff, errors→empty-set), the
  summary/progress count is GetViewedFileCount over the resolved states,
  and the changed-since marker (box.tmpl:141-143) renders; the internal
  HasChanged persistence write of SyncUserSpecificDiff (:1566-1576) is NOT
  ported — recorded (the recompute covers the stale-cursor window; no
  writes on GET). Tests: schema.test's FN-3 describe (DDL pin, legacy-row
  default, the merge ladder) + pull-files.matrix's rewritten round-trip and
  its new real-engine FN-3 describe (subset post, advance inheritance,
  per-file read-back, the page arms).
- **FN-2: comments mutation-metadata completion (7 census columns; 5 to
  PORT).** Missing: `comment_meta_data` (comment.go:360),
  `project_id`/`old_project_id` (project-move comments, comment.go:291-292),
  `time_id` (time-tracking comments, comment.go:301), `assignee_team_id`
  (team review requests, comment.go:307) — additive NULLable/DEFAULT-0
  ports; unlocks the comment-type families ours renders as gaps. Two
  census columns folded out by errata: `patch_quoted` never existed (the
  §4 erratum — upstream's column IS `patch`, the comment.go:330 bare-token
  override: parity) and the `original_author`/`original_author_id` pair
  (comment.go:280-281) is recorded-absent by §7.11 + SPEC-0005 §9, not
  ported. **LANDED (2026-11-03, migration 0067 — pure ADD COLUMN + the
  JSON-gated backfills; the type-30/31/time/team writers stamp the columns
  with `content` empty, the timeline readers render the columns, the team
  arm, and the exact `time_id` row; SPEC-0005 §7 is the as-built record.
  Tests: schema.test's FN-2 describe (DDL + the backfill statements
  verbatim, the conservative arms) + the FN-2 describes in the
  issue-timeline-writes, issue-tables-t2, pull-reviews and issues
  batteries).**
- **FN-4: repositories upstream-column completion (26 columns).**
  **STATUS: LANDED (2026-11-03, migration `0068_repositories-port-columns`
  + the writer legs — unit FN-4; the rest of this row is the original
  scope, kept for the cites; the §4 repositories section carries the
  landed annotations and SPEC-0001 §4.1 is the as-built record).** The
  18-column port (GR's split: 18 drift + 4 recorded folds + 4 staged
  folds) landed as ONE additive migration (18 ADD COLUMN + 1 CREATE
  INDEX — no rebuild, the FN-6 DQS audit applied) with the three real
  backfills (name ← slug copy — display case unrecoverable, recorded;
  description/website ← repo_settings; topics ← the repo_topics recount,
  syncTopicsInRepository's ASC shape, '[]' for topic-less). Writer legs by
  surface owner: identity/edit (create/rename/case-only-PATCH display-case
  stamps; description/website moved OUT of repo_settings with the reader
  flips — the convert, forks, generate, the feeds, the settings page;
  the API `name` renders display case now), counters (projects create
  +1/close-reopen-delete recount, project.go:282/:358-375; actions runs
  recounted by services/actions updateRepoRunsNumbers at the create,
  refreshRunStatus, cancel and delete arms — run.go:258-284's shape),
  sizes (git_size/lfs_size split AND `size_kb` widened to git+LFS at the
  repo-size settle points, the byte-sum floor), long-tail (archived_unix
  stamp on the archive toggle; the create seeds object_format_name/
  default_wiki_branch/is_fsck_enabled(!mirror)/trust_model;
  original_service_type 'git' on the migrate arm; template_id +
  repositories_template_id_idx, TEXT per the id-family rule — a recorded
  shape correction over the matrix's INTEGER cell). Port-when-read,
  recorded not invented: avatar, is_fsck_enabled settings/fsck arms,
  trust_model signing arm, adopt's service type, template_id readers.
  Errata folded at port time: the isTemplate cite fixed :190→:201; the
  status cite DISPROVEN, left exact; adopt.go's OriginalServiceType :58
  re-verified EXACT. Tests: schema.test's FN-4 describe (the 18-column
  DDL pin + the three backfills verbatim) + the writer-leg batteries
  (repo-settings, lifecycle identity stamps, projects tallies,
  model.test runs-numbers, repo-size split, user-repos/generate/
  migrate/topics render).**
  The
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
- **FN-5: the gonic-quirk + project rename batch (one migration).**
  **STATUS: LANDED (2026-11-04, migration `0069_fn5-upstream-column-names`
  — hand-authored ALTER set per the 0064 --custom precedent: 1 RENAME
  TABLE + 17 RENAME COLUMN + the protected_branches_repo_rule_uq rebuild,
  applied local and verified on carried rows (PRAGMA before/after +
  read-backs under the new names); the 0069 snapshot hand-moved to the
  post-rename state so the next diff stayed pure — the drizzle-kit
  interactive-rename flow of §7.10.4 was superseded, its non-TTY fail-loud
  verdict confirmed. The fixture blast came out 41 lines across 14 test
  files (the §7.10 table's ~26/6 undershot the cleanup-list entries, the
  0067 backfill replay, and lifecycle's fourth INSERT) — the SPEC-0005 §8
  as-built block carries the full landing + FN-7's rider; the rest of this
  row is the original scope, kept for the cites).** 18 renames (17 columns + 1 table), every member
  re-verified at the pin against the §1 override rule; the per-member
  cite table, the same-class sweep, the blast radius, and the drizzle
  migration-shape verdict are §7.10; the plan is SPEC-0005 §8. The batch
  renames ONLY schema.ts's explicit column-name strings — drizzle
  property and table-export names are KEPT (upstream's Go field names
  map to ours properties), so it is zero application-code churn plus
  ~26 raw-SQL test-fixture lines. All name-only renames to upstream's
  literal DDL: `team_ids`→`team_i_ds`
  (transfer.go:72 — `TeamIDs` untagged, pure GonicMapper),
  `allowlist_team_ids`/`allowlist_user_ids`→`..._i_ds` (protected_tag.go:27-28
  — the tags carry type tokens `JSON TEXT` only, no column override),
  `protected_branches.rule_name`→`branch_name` + `rules`→`config`
  (protected_branch.go:34,38 — upstream pins both via quoted tags
  `'branch_name'`/`'config'`),
  `project_columns`→`project_board` (table) + `is_default`→`default`
  (column.go:49,52; TableName override column.go:66-68 — upstream keeps
  the legacy name under its own TODO),
  `project_issues.project_column_id`→`project_board_id` (project/issue.go:21 —
  upstream pins it via the quoted tag `'project_board_id'`),
  `project_workflows event/filters/actions`→`workflow_*`
  (workflows.go:163-165), `tracked_time.seconds`→`time` (tracked_time.go:30),
  `issues.title`→`name` (issue.go:63 — the explicit xorm column-NAME tag;
  upstream's writes and search bind the literal column, issue_update.go:198
  + issue.go:536; §7.8),
  `pull_auto_merges issue_id`→`pull_id` + `merge_message`→`message`
  (automerge.go:19,23), `audit_event.created_unix`→`timestamp_unix`
  (audit_event.go:37), `repo_transfer.new_owner_id`→`recipient_id`
  (transfer.go:68 — untagged; upstream's own query binds `recipient_id`,
  transfer.go:177 — ADDED by the §7.10 sweep), and
  `review_state.issue_id`→`pull_id` (review_state.go:44 — untagged; the
  NAME+VALUE-SPACE twin of the pull_auto_merges member — ADDED by the
  §7.10 sweep; the value-space arm stays FN-3's optional-unrecorded
  note). Two sweep resolutions: the former conditional member
  `issue_subscriptions`→`issue_watch` RESOLVES TO KEEP (§7.5 records the
  association rename; not a batch member), and the migration shape is
  ALTERs-only — drizzle-kit generates RENAME COLUMN/RENAME TABLE when
  its interactive rename prompt is answered (§7.10.4; never drop+add).
  Zero API surface; do it in one generated migration to pay the rename
  tax once. Method note: two earlier
  members — `redirect_uris`→`redirect_ur_is` and the package_blobs
  `hash_*` quartet — were WITHDRAWN (2026-11-03, §7.8): explicit
  first-token column overrides mean upstream already has the plain names;
  every surviving member was re-verified against the §1 override rule.
- **FN-6: repo_units completion.** **STATUS: LANDED (2026-11-03, migration
  `0066_repo-unit-parity-columns` + the SPEC-0003 §3.1 as-built block — the
  rest of this row is the original scope, kept for the cites; the §3.1 row
  and the §4 repo_unit section carry the LANDED annotations).** Missing
  `id`, `created_unix`, `everyone_access_mode` (repo_unit.go:43,47,49 — the
  original cites said :44,48,50, off by one, corrected at landing; the 2026
  upstream everyone-permission column is a real capability gap). Landed as:
  the INTEGER autoincrement `id` pk (the §2.1 non-referencing-pk family)
  with the natural (repo_id, type) key kept as `repo_units_repo_type_uq`
  (ours-stricter vs upstream's non-unique INDEX(s) — the toggles' ON
  CONFLICT target); nullable `created_unix` stamped by the create seed
  (repos/service.ts) and backfilled by 0066 from repositories.created_at —
  the rebuild's generated copy had to be corrected (it selected the new
  columns from the old table and SQLite's double-quoted-string rule turned
  them into the literal strings 'created_unix'/'everyone_access_mode';
  caught by the local-apply gate, fixed in the migration text); and the
  `everyone_access_mode` TEXT enum `none|read|write` NOT NULL DEFAULT
  'none' with NO writer and NO reader in our surface yet (port-when-read —
  upstream's flip arm is PublicAccessPost, public_access.go:134-153 via
  UpdateRepoUnitPublicAccess repo_unit.go:374-378; its reader is the
  calculator's everyone ladder, repo_permission.go:231-234). Enum-text
  family (`type`, `anonymous_access_mode`) stays under §2.3.
- **FN-7: pull_auto_merges completion.** **STATUS: LANDED (2026-11-04,
  migration `0070_fn7-automerge-merged-commit-id` — pure ADD COLUMN
  `merged_commit_id` text, nullable, no rebuild (the 0066 DQS audit
  applied); the stamp arm landed in mergePullRequest's merged section:
  `MergePullOptions.wasAutoMerged` (upstream automerge.go:262's `true`
  arg) gates `stampAutoMergeCommit` (services/pull/merge.go:265-274's
  recordMergeIntent) BEFORE the composed schedule-cleanup delete
  (:829-838); the consumer passes true; the stamp pin rides
  pull-automerge.test.ts. clearMergeIntent's schedule-stamp revert
  (merge.go:289) is a recorded non-port — our engine stamps D1 only after
  the push landed, so its trigger cannot arise; SPEC-0005 §8.6 as-built).**
  Missing `merged_commit_id`
  (automerge.go:26 — the recorded merge result); ours-extra `sha` (the
  head-sha gate) stays as a recorded addition. Rides FN-5's renames.
- **FN-8: commit_statuses completion.** **STATUS: DERIVED (2026-11-04,
  §7.12 + SPEC-0005 §10 PLAN ONLY) — nothing is built; the port unit's
  normative plan is staged.** Missing `context_hash`
  (commit_status.go:50) + `index` (commit_status.go:41 — the per-sha
  monotonic index; pairs with the documented `commit_status_index`
  TODO in `api/services/commit-status.ts:88-91`). API-visible: upstream
  emits the per-sha index as the status `id`
  (services/convert/status.go:24) — the blast-radius table for that
  id-semantics flip is §7.12 §3 (the webhook payload keeps the row pk,
  services/webhook/notifier.go:942 — the asymmetry is upstream's own).
- **FN-9: the original_author family.** **STATUS: DISPOSITIONED as
  intentional-recorded-absent (2026-11-03, §7.11 + SPEC-0005 §9 RECORD) —
  the row is closed as a record; no migration is planned.** `releases`,
  `reactions`, `pull_reviews` each missing `original_author` +
  `original_author_id` (release.go:74-75, reaction.go:69-70,
  review.go:130-131 — the original cites :75-76/:70-71/:131-132 were off
  by one) — upstream's columns for migrated authorship, whose ONLY writer
  is the forge-metadata migration importer's `RemapExternalUser` remap
  (§7.11: every write path flows through
  `services/migrations/gitea_uploader.go` `remapUser`). Our surface has
  no importer (SPEC-0009 §1 out-of-scope bullet; §2.2 — the migrate
  endpoint answers `422` on the metadata flags; implemented
  `src/services/migrate.ts:185-194`, pinned by
  `src/services/migrate.test.ts:574`) and no reader (grep 0), so a port
  would add permanently-NULL state. The `issues` twin pair
  (schema.ts:676-678, present-but-unwritten) is recorded RESERVED by the
  same record.
- **FN-10: issue_pins + issue_labels pk completion.** `issue_pins`: add
  `id`, `is_pull` (issue_pin.go:18,21) and settle the inverted
  nullability on `repo_id`/`issue_id`; `issue_labels`: add `id`
  (issue_label.go:20) or record the composite-PK choice.
- **FN-11: package_blob_upload resumable state.** Missing
  `hash_state_bytes` (package_blob_upload.go:27 — the rolling upload
  checksum state); ours `chunk_count` is the recorded replacement —
  port-or-record.
- **FN-12: small completions.** `gpg_keys.emails` (gpg_key.go:33 — the
  serialized address list), `issue_dependency.updated_unix`
  (dependency.go:107), `repo_transfer.recipient_access_granted` +
  `updated_unix` (transfer.go:75,78), `repo_collaborators.id` +
  timestamp arm (collaboration.go:21), `lfs_locks.lower_path` record
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
| `issue_subscriptions.created_unix` / `.updated_unix` | NULLable (schema.ts:999-1000) | `NOT NULL` (models/issues/issue_watch.go:22-23) | **stays DRIFT** — tightening queued; recommended carrier FN-12 (small completions, same-table DDL); census row §3.1 reclassified aligned → drift |
| `issue_pins.repo_id` | NULLable TEXT (schema.ts:1096) | `int64 UNIQUE(s) NOT NULL` (models/issues/issue_pin.go:19) | **stays DRIFT** — rides FN-10 (also a TEXT id-family column, §2.1) |
| `users.email` / `users.avatar_email` | NULLable (schema.ts:440, 457) | `NOT NULL` (models/user/user.go:101, 149) | **intentional-recorded** via SPEC-0002 §4.6 item 16 — part of the recorded users reduction: orgs ARE user rows here and the org-create surface writes `email: input.email ?? null`, `avatarEmail: null` (services/orgs/orgs.ts:430-437); upstream's org-as-user-row survives the same NOT NULL only because xorm writes the Go zero `''` for the never-set fields (CreateOrganization, models/organization/org.go:316-337, sets no Email) — ours models "no email" as NULL where upstream stores `''`; same information, different zero convention |
| `repo_transfer.created_at` | NOT NULL DEFAULT unixepoch (schema.ts:314-316) | `INDEX NOT NULL created` (models/repo/transfer.go:77) | parity-strict — checked because §2.7's itemization hinted at it; no inversion |

Errata to §2.7's minority-arm itemization (recorded here; folded into
§2.7's own text by the census-owner cleanup, §7.8): `issue_pins.issue_id` is NOT inverted (ours is the
composite PK, NOT NULL — schema.ts:1095 — vs upstream `NOT NULL`,
issue_pin.go:20: same strictness); the §3.1 census row's `pin_order`
claim is likewise withdrawn (ours NOT NULL — schema.ts:1097 — vs
upstream nullable `DEFAULT 0`, issue_pin.go:22: that direction is the
ours-stricter blanket, not an inversion).

### 7.2 The timestamp-name family — intentional-recorded; mass rename declined

Erratum to §2.5 first: the family as §2.5 sketched it is wrong on two of
three arms, and the true divergence is SMALLER than "~30 tables":

1. **The actions family (`created`/`updated`) is NOT a divergence.**
   Upstream's column is `created`/`updated` in every actions table —
   ten via fields literally named `Created`/`Updated` whose
   GonicMapper rendering IS the column name (models/actions/
   run.go:74-75, run_job.go:135-136, task.go:57-58, task_step.go:32-33,
   runner.go:70-71, runner_token.go:39-40, run_attempt.go:38-39,
   run_job_summary.go:52-53, schedule.go:36-37, schedule_spec.go:33-34)
   and four via `CreatedUnix`/`UpdatedUnix` fields whose auto-fill tags
   pin the column name explicitly (artifact.go:87-88,
   tasks_version.go:23-24, scoped_workflow.go:30-31, variable.go:38-39 —
   precision note from the §7.9 cite-audit: the original sentence claimed
   all fourteen fields were literally `Created`/`Updated`; the
   conclusion is unchanged). Ours matches verbatim
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
| `repositories` (schema.ts:79,85) | models/repo/repo.go:218-219 | created_unix, updated_unix | created_at, updated_at |
| `repo_transfer` (schema.ts:314) | models/repo/transfer.go:77 | created_unix (updated_unix MISSING on ours — FN-12) | created_at |
| `users` (schema.ts:488,529) | models/user/user.go:122-124 | created_unix, updated_unix, last_login_unix | created_at, last_login_at |
| `personal_access_tokens` (schema.ts:566) | models/auth/access_token.go:30-31 | created_unix, updated_unix | created_at (no updated column on ours — upstream `updated_unix` feeds only `HasUsed`/`HasRecentActivity`, replaced by the SPEC-0002 §2.7/§4.6 items 5+13 last-used-throttle record) |
| `lfs_objects` (schema.ts:1252-1253) | models/git/lfs.go:84-85 | created_unix, updated_unix | created_at, updated_at |
| `lfs_locks` (schema.ts:1294) | models/git/lfs_lock.go:27 | created | created_at |
| `user_redirects` (schema.ts:1392) | models/user/redirect.go:38-42 — NO timestamp columns upstream | — | created_at (ours-extra column, not a rename) |
| `repo_redirects` (schema.ts:289) | models/repo/redirect.go:39-43 — NO timestamp columns upstream | — | created_at (ours-extra column, not a rename) |
| `repo_watchers` (schema.ts:1480) | models/repo/watch.go:44 | created_unix | created_at |
| `repo_collaborators` (schema.ts:1506-1507) | models/repo/collaboration.go:25-26 | created_unix, updated_unix | created_at, updated_at |
| `follows` (schema.ts:1560) | models/user/follow.go:20 | created_unix | created_at |
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
(:3552 — upstream's own name is `timestamp_unix`, audit_event.go:37;
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
`Follow.UserID int64 xorm:"UNIQUE(follow)"` (models/user/follow.go:18)
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
shorthand (upstream's own newer tables use `UserID`: follow.go:18,
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
| 2 | `comments.issue_id` | notNull (schema.ts:747) | `IssueID int64 xorm:"INDEX"` → nullable (comment.go:283) | ours-stricter ✓ |
| 3 | `comments.invalidated` | notNull default false (schema.ts:768) | `Invalidated bool` → nullable (comment.go `Invalidated` field) | ours-stricter ✓ |
| 4 | `issues.title` | notNull (schema.ts:624) | `Title string xorm:"name"` → nullable (models/issues/issue.go:63) | ours-stricter ✓ — and a SIDE-FIND, see below |
| 5 | `issue_pins.repo_id` | nullable TEXT (schema.ts:1096) | `int64 UNIQUE(s) NOT NULL` (issue_pin.go:19) | ours-looser inversion ✓ |
| 6 | `issue_subscriptions.created_unix` / `.updated_unix` | nullable (schema.ts:999-1000) | `created NOT NULL` / `updated NOT NULL` (issue_watch.go:22-23) | ours-looser inversion ✓ |
| 7 | `users.email` / `.avatar_email` | nullable (schema.ts:440,457) | `NOT NULL` (user.go:101,149) | ours-looser inversion ✓ — recorded, SPEC-0002 §4.6 item 16 |
| 8 | `follows.user_id` | `user_id` (schema.ts:1554) | `UserID` → `user_id` (follow.go:18; query binds `user_id`) | parity ✓ — §2.6 erratum |
| 9 | `stars.user_id` | `user_id` (schema.ts:1588) | `UID` → `uid` (star.go:19; query binds `uid` at star.go:73) | rename member ✓ |
| 10 | `action_runs.created` / `.updated` | `created`/`updated` (schema.ts:4076-4077) | `Created`/`Updated` fields → `created`/`updated` columns (run.go:74-75) | parity ✓ — §2.5 erratum |
| 11 | `repo_transfer.created_at` | NOT NULL DEFAULT unixepoch (schema.ts:314-316) | `INDEX NOT NULL created` (transfer.go:77) | parity-strict ✓ (checked, no inversion) |
| 12 | `reactions.user_id`/`.type` | notNull (schema.ts:897-905) | `UNIQUE(s) NOT NULL` (reaction.go:65-71) | parity-strict ✓ (the blanket is not universal — parity-strict columns exist and are not family members) |

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
families and outside this unit's cell ownership. RESOLVED by the
census-owner cleanup (§7.8, 2026-11-03): the find VERIFIED at the pin;
the row is flipped and FN-5 carries the rename.

Corroboration counts (not a re-derivation): upstream `NOT NULL` xorm
tags ≈ 269 over 1081 census columns; ours `.notNull()` = 715 over 1010
(schema.ts grep, PK columns excluded by their own declaration shape).
Direction and magnitude corroborate §2.7; the 386 figure stays the §1
parser's census number.

Errata index — EMPTIED (2026-11-03 census-owner cleanup, §7.8): every
entry this index once carried is folded in-place — §2.5's timestamp
family and §2.6's uid family now state their corrected memberships,
§2.7's ours-looser itemization drops the withdrawn `issue_pins.issue_id`
member and points at §7.1's table, §4 repo_transfer's `updated_unix`
cite reads transfer.go:78 (FN-12's twin cite fixed the same way), and
the §3.1 `hook_task` row already carried the corrected SPEC-0005 §3.6
cite (verified against the SPEC's headings: §3.6 exists, §3.7 does not).

### 7.8 Census-owner cleanup (2026-11-03) — side-find verified; two false drifts withdrawn; errata folded

**1. The §7.7 side-find VERIFIES — `issues.title` is a real column-name
drift; the census row was wrong to call the table aligned.** Re-verified
with my own eyes at the pin: the field carries an explicit column-NAME
tag — `Title string xorm:"name"` (models/issues/issue.go:63) — so the
SQL column is `name`, not the field-name mapping `title`; upstream's own
SQL binds that literal on both sides (title writes: `UpdateIssueCols(ctx,
issue, "name")` inside ChangeIssueTitle, models/issues/issue_update.go:198;
keyword search: `BuildCaseInsensitiveLike` over the backticked column,
models/issues/issue.go:536); ours declares `title: text("title")`
(schema.ts:624). A sweep of `gitea/models/issues/` for stray `name`
binds hit only label/milestone's own parity `name` columns; the pin
carries no migrations tree to cross-check a CREATE TABLE. Edits: §3.1
`issue` row **aligned → drift** (reason carries both-side cites; FN-5
recorded as the carrier); §4 gains the `issue` subsection with the
RENAME line (the intro's subsection count updated).

**2. TWO FALSE DRIFTS withdrawn (FY2's spot-sample, re-verified at this
pin).** The census had called two tables drift on "gonic-quirk renames"
that DO NOT EXIST upstream — both fields carry explicit xorm first-token
column overrides, and ours already matches:
- `oauth2_application`: `RedirectURIs []string xorm:"redirect_uris JSON
  TEXT"` (models/auth/oauth2.go:51) — upstream column `redirect_uris`;
  ours `redirect_uris` verbatim (schema.ts:3184). Census row **drift →
  aligned**; its §4 subsection (one RENAME line) deleted.
- `package_blob`: `HashMD5 xorm:"hash_md5 char(32) UNIQUE(md5) INDEX NOT
  NULL"`, `hash_sha1 char(40)`, `hash_sha256 char(64)`, `hash_sha512
  char(128)` (models/packages/package_blob.go:33-36) — ours matches all
  four names verbatim (schema.ts:3700-3704). Census row **drift →
  intentional-recorded** (NOT aligned, a deliberate deviation from the
  dispatch): the residual divergence is real but recorded — ours keeps
  md5/sha1/sha512 NULLABLE where upstream is NOT NULL (Workers'
  WebCrypto has no MD5; generic uploads land `hash_md5` NULL; NULLs
  keep the UNIQUE indexes sound) — SPEC-0016's package_blobs data-model
  bullet + the schema.ts table comment. Its §4 subsection (four RENAME
  lines) deleted.
Consequence: FN-5 as previously written prescribed renaming ours to
column names upstream does not have — executing it would have BROKEN
parity, the opposite of the batch's goal. Both FN-5 items are dropped;
every surviving member was re-verified mechanically against the §1
override rule at the pin and all HOLD (transfer.go:72 `TeamIDs` untagged;
protected_tag.go:27-28 tags carry `JSON TEXT` type tokens only;
protected_branch.go:34,38 quoted `'branch_name'`/`'config'` tags — true
legacy pins; project/issue.go:21 quoted `'project_board_id'`; column.go:52
`Default` untagged; workflows.go:163-165 `TEXT JSON` type tokens only;
tracked_time.go:30 `NOT NULL` only; automerge.go:19,23 `UNIQUE`/
`LONGTEXT` only; audit_event.go:37 `INDEX NOT NULL` only; issue.go:63
`name` — the one true column-NAME tag in the batch). FN-5's member cites
were corrected to the verified field lines in the same pass (several
were off by one).

**3. Method rule added to §1.** GonicMapper runs ONLY when the tag does
not name the column; an explicit first token wins and a quoted first
token pins a legacy name. §1's quirk-name examples were corrected:
`redirect_ur_is` (`RedirectURIs`) and `hash_m_d5` (`HashMD5`) never
existed upstream — the true quirks are `team_i_ds` and the protected_tag
allowlist pair.

**4. The errata index is folded and emptied** (the paragraph above is
now a pointer). §2.5's timestamp-family text states the corrected arms
(actions = parity; the SPEC-0001/0005-era tables are the parity side;
true divergence = 16 paired tables, census at §7.2); §2.6's uid-family
text lists the true 7 members and withdraws `follow` (census at §7.3);
§2.7's ours-looser itemization drops the withdrawn `issue_pins.issue_id`
member and points at §7.1's table (§7.1's "left as written" note
updated); §4 repo_transfer's `updated_unix` cite corrected
transfer.go:79 → :78 (verified at the pin: :75 `RecipientAccessGranted`,
:77 `CreatedUnix`, :78 `UpdatedUnix` — the :76 this paragraph originally
claimed for `RecipientAccessGranted` was itself one off, corrected by the
§7.9 cite-audit) and FN-12's twin cite fixed the
same way; the §3.1 `hook_task` row's in-row §3.6 cite verified against
SPEC-0005's headings (§3.6 "Webhook delivery (Cloudflare Queues)"
exists; no §3.7).

**5. The broken `external_login_user` cite fixed.** The census row
cited external-auth-sources §7.6/§7.8, but that SPEC's §7 is a single
numbered edge-case list (items 1-13) with no subsections — §7.6/§7.8
are list items, not sections. The normative home of both census claims
(raw_data dropped; token columns written empty) is §4.3, which carries
the data model with both decisions inline (`raw_data` is likewise
dropped... v1 persists the bounded profile fields only; the token-field
comment "v1 WRITES EMPTY"); the upstream shape is §2.6. The row now
cites §4.3 (+§2.6).

**6. Headline tallies re-derived — FN-13's un-propagated flip caught.**
Before this unit the census body counted 46 aligned / 27 drift / 22
intentional-recorded / 22 missing-table (= 117), but the Headline still
claimed 47/26/22/22: FN-13's §7.6 `issue_watch` aligned→drift flip had
never been propagated. This unit's verdict moves: `issue`
aligned→drift; `oauth2_application` drift→aligned; `package_blob`
drift→intentional-recorded. Final, re-grepped from the §3.1 table:
**46 aligned + 23 intentional-recorded + 26 drift + 22 missing-table =
117** (117 rows re-counted ✓; ours-extras 12 and the ours-side
95-paired + 12 = 107 arithmetic unchanged — none of the three moves
touches a pairing). The table-specific drift-column figure drops
69 → 65: §4 now carries 32 MISSING + 21 RENAME + 5 OURS-EXTRA + 7 TYPE
structural lines outside the `repositories` subsection (+1
`issues.title` RENAME, −5 for the withdrawn false RENAMEs). (This was
that unit's as-run tally — the §7.11 original_author flips later moved
three tables drift → intentional-recorded; the CURRENT tally is the
Headline's 46/26/23/22, re-grepped at §7.9, and the MISSING count is
32 → 31 after the patch-parity erratum's withdrawal.)

### 7.9 The cite-audit — every upstream file:line cite verified at the pin (census-owner unit GL-resume, 2026-11-03)

Scope: every `gitea/` file:line cite in the Headline through §7.11,
verified by reading the cited line at the pin `fc4936884584`. Enumerated:
434 textual cite instances → 380 unique (file, span) pairs, plus 30
context-inherited cites (bare-colon spans like `(:138-147)` and
partial-path names like `project/issue.go:21`) = 410 unique verification
targets; each was read at the pin, with the claimed field confirmed in
the cited line. GN's landed §7.11 and GJ's landed §4-expansion cites
re-verified as part of the sweep (all exact except where noted below).

**Checked / fixed.** This unit's predecessor (GL, quota-killed
mid-pass) had already corrected 77 cite lines whose edit was a pure
digit change (the worktree hunks this unit inherited) plus the
cite-bearing prose rewrites (the §3.1 `comment`/`reaction`/`review`/
`release` rows, the FN-2/FN-9/FN-3/FN-6 bullets, §2.5's actions
paragraph, §7.11 §5's dedup-key note); this unit re-verified all 77 at
the pin — zero rejects — and found two further wrong cites, fixed here:
(1) §7.7 row 2's `comment.go:284` → **:283** (`IssueID int64
xorm:"INDEX"` sits at :283; :284 is `Issue *Issue xorm:"-"` — the
pattern's own +1); (2) §5 FN-3's `pull.go:853` → **`routers/web/repo/
pull.go:853`** — the line number was exact, but the census's bare
short-name `pull.go` resolves to the models file; the statement's
`filesViewedState = reviewState.UpdatedFiles` lives in the WEB ROUTER,
not `models/issues/pull.go`.

**The pattern's root.** The census's line cites came from session-
scratch parsers (§6: not committed — the mechanism below is inferred
from the surviving error shapes, not from the code). The errors are
positional, not random: (a) dominant +1 (~85% of GL's 77): the cite
recorded the line FOLLOWING the field — in a clustered xorm block that
is the neighbor field's line, so pair-cites straddled (the original
review.go:131-132 covered `OriginalAuthorID` plus the `xorm:"-"` Issue
pointer); (b) anchor-reuse: small structs cited the struct's first
field line as a shorthand for fields that sit lower — follow.go:17
(the `ID` line) stood for BOTH `UserID` (§7.3, actual :18) and
`created_unix` (§7.2, actual :20), which proves those cites were never
read back per field; (c) span-straddle: multi-column spans anchored on
the struct header and counted columns instead of lines (the original
reaction.go:63-70 for the actual :65-71 started inside the pk/blank gap
and dropped the trailing `type` column). Accuracy was NOT uniform:
every cell the §7.8 re-verification had already line-checked (the
gonic-quirk batch — transfer.go:72, protected_tag.go:27-28,
protected_branch.go:34,38, column.go:49,52, workflows.go:163-165,
tracked_time.go:30, automerge.go:19,23, audit_event.go:37, issue.go:63,
oauth2.go:51, package_blob.go:33-36, pull.go:100-107) and §7.7's spot
table check exact at this pin; the +1 ran through the census's
structural-diff output cells (§4's MISSING/TYPE lines and the §5 FN
bullet cites), not through the hand-verified ones.

**Exceptions and scope notes.** (a) Ours-side line cites (`schema.ts`,
`src/**`) are working-tree snapshots and were NOT audited — sibling
landings shift them by design (§3.4's own disposition). Observed stale
during the sweep, left for the landing re-pin: the §3.1
`oauth2_grant`/`oauth2_authorization_code` rows' ours-cites
(schema.ts:3215/:3253) and §7.2's :3236-3237 point into the pre-FM
region (the tables now export at schema.ts:3293/:3331). (b) Concurrent
units landed in this file while the sweep ran, and their cites are
their units' cells, not audited here: GS's §3.3 no-reader scrutiny
(+3 hunks), GR's FN-4 disposition expansion (the `repositories`
subsection is now GR's Table 1/Table 2 — whose "26 upstream cites
re-verified EXACT-LINE" note independently corroborates GL's repo.go
corrections), and GM's FN-5 derivation, which landed as §7.10 BELOW
this section after the sweep had passed its insertion point — its
cites (and §5's FN-5 row, its cell) are the GM-resume unit's
verification burden, per its charter. (c) Upstream cites are
pinned to `gitea/` @ `fc4936884584`; that pin is what keeps every cite
in this file re-checkable — re-run this section's sweep at any future
pin bump. (d) Two census-owner errata surfaced by the sweep were folded
in place: §2.4's bare-integer example list (two of its three members
have gained the mode wrapper — verified at schema.ts:540-543/:73-77,
flagged first by GR) and the Headline's recorded-absent figure
(6 → 8, below).

**Arithmetic re-grepped by machine at landing** (not eyeball counts):
§3.1 verdicts 46 aligned + 26 intentional-recorded + 23 drift + 22
missing-table = 117 rows ✓ (the two LANDED-annotated rows —
`review_state`, `repo_unit` — count in the 23); §4 structural lines
outside the `repositories` subsection: 31 MISSING + 21 RENAME +
4 OURS-EXTRA + 7 TYPE = 63 ✓ (the struck `patch_quoted` line excluded);
the `repositories` residual's 26 MISSING upstream columns now live in
GR's Table 1 disposition (not 26 port columns — 18 port + records +
folds). The Headline's recorded-absent figure was corrected 6 → 8 in
the same pass: ALL FOUR original_author pairs (comment's included) are
§7.11-recorded absent, which is exactly why FN-2 ports 5, not 7.

### 7.10 FN-5 derivation — final member list, the same-class sweep, blast radius, and the migration shape (GM-resume unit, 2026-11-03)

Closes the FN-5 row's owed derivation. Everything below was re-verified
with my own eyes at the pin `fc49368845` (both sides); the plan carrier is
**SPEC-0005 §8 — PLAN ONLY** (nothing built; the FN-5 row's status points
there). The batch's contract, derived here and normative in the SPEC: the
renames change ONLY schema.ts's explicit column-name strings — drizzle
properties and table export names are KEPT (upstream's Go field names map
to ours drizzle properties, so property-kept is the zero-application-churn
shape), and all upstream-parity HTTP surfaces stay as they are.

**1. The final member list — 18 renames (17 columns + 1 table), all
verified at the pin.** Every tag reading below applies §1's override rule
(GonicMapper runs only when the tag does not name the column; a quoted
first token pins a legacy name):

| # | member (ours → upstream DDL) | upstream cite at the pin | ours cite | tag class |
|---|---|---|---|---|
| 1 | `repo_transfer.team_ids` → `team_i_ds` | transfer.go:72 `TeamIDs` untagged | schema.ts:332 | mapper |
| 2 | `protected_tags.allowlist_team_ids` → `allowlist_team_i_ds` | protected_tag.go:28 `AllowlistTeamIDs xorm:"JSON TEXT"` | schema.ts:3133 | mapper |
| 3 | `protected_tags.allowlist_user_ids` → `allowlist_user_i_ds` | protected_tag.go:27 same shape | schema.ts:3131 | mapper |
| 4 | `protected_branches.rule_name` → `branch_name` | protected_branch.go:34 quoted `'branch_name' UNIQUE(s)` | schema.ts:2573 | quoted pin |
| 5 | `protected_branches.rules` → `config` | protected_branch.go:38 quoted `'config' JSON LONGTEXT` | schema.ts:2579 | quoted pin |
| 6 | `project_columns` → `project_board` (TABLE) | project/column.go:66-68 `TableName()` override (upstream's own TODO keeps the legacy name) | schema.ts:2995 | table-name override |
| 7 | `project_columns.is_default` → `default` | column.go:52 `Default xorm:"NOT NULL DEFAULT false"` | schema.ts:3004 | mapper |
| 8 | `project_issues.project_column_id` → `project_board_id` | project/issue.go:21 quoted `'project_board_id' INDEX` | schema.ts:3048 | quoted pin |
| 9 | `project_workflows.event` → `workflow_event` | workflows.go:163 `WorkflowEvent` no tag | schema.ts:3078 | mapper |
| 10 | `project_workflows.filters` → `workflow_filters` | workflows.go:164 `TEXT JSON` tokens only | schema.ts:3081 | mapper |
| 11 | `project_workflows.actions` → `workflow_actions` | workflows.go:165 `TEXT JSON` tokens only | schema.ts:3084 | mapper |
| 12 | `tracked_time.seconds` → `time` | tracked_time.go:30 `Time xorm:"NOT NULL"` | schema.ts:1920 | mapper |
| 13 | `issues.title` → `name` | issue.go:63 `Title xorm:"name"` — the explicit column-NAME tag; upstream's own SQL binds it (issue_update.go:198, issue.go:536) | schema.ts:624 | column-NAME tag |
| 14 | `pull_auto_merges.issue_id` → `pull_id` | automerge.go:19 `PullID xorm:"UNIQUE"` | schema.ts:4994 | mapper (NAME+VALUE-SPACE) |
| 15 | `pull_auto_merges.merge_message` → `message` | automerge.go:23 `Message xorm:"LONGTEXT"` | schema.ts:5004 | mapper |
| 16 | `audit_event.created_unix` → `timestamp_unix` | audit_event.go:37 `TimestampUnix xorm:"INDEX NOT NULL"` | schema.ts:3552 | mapper |
| 17 | ★ `repo_transfer.new_owner_id` → `recipient_id` | transfer.go:68 `RecipientID` untagged; upstream's own query binds `recipient_id` (transfer.go:177) | schema.ts:313 | mapper — **ADDED by the §7.10 sweep** |
| 18 | ★ `review_state.issue_id` → `pull_id` | review_state.go:44 `PullID xorm:"NOT NULL INDEX UNIQUE(pull_commit_user) DEFAULT 0"` — type tokens only; binds :71,:132,:143 | schema.ts:4971 | mapper (NAME+VALUE-SPACE) — **ADDED by the §7.10 sweep** |

Withdrawn members stay withdrawn (§7.8 item 2: `redirect_ur_is` and the
package_blobs `hash_*` quartet — upstream pins those names via explicit
first-token overrides ours already matches verbatim). The row's former
conditional member `issue_subscriptions` → `issue_watch` RESOLVES TO KEEP:
§7.5 records `issue_watch` → `issue_subscriptions` as an intentional
association rename (the SPEC-0005 §3.2 block), so it is not a batch
member. Members 14 and 18 carry the NAME+VALUE-SPACE caveat their §4
lines already record (ours `issue_id` stores `issues.id`; upstream
`pull_id` stores `pull_request.id`) — the batch renames the COLUMN only;
the value-space arm stays exactly what FN-3's landed note says
(optional-unrecorded, safe while the rows stay 1:1). Member 18's twin is
member 14 — the §4 RENAME inventory lists both, but the FN-5 row had
only the pull_auto_merges one; the sweep symmetry finding puts both in
the same migration.

**2. The same-class sweep — method and negative results.** Three arms:
(a) The complete §4 RENAME inventory (21 lines) classified line by line:
16 were already members, 4 belong to recorded families and stay out
(`repo_transfer.created_unix`→`created_at`,
`repo_collaborators.created_unix/updated_unix`→`*_at` — §7.2's recorded
timestamp-name family; `lfs_locks.created`→`created_at` — same family,
census row §7.2), and 2 are the additions above (members 17-18). (b) The
quoted-pin sweep: `grep -rn 'xorm:"\'' gitea/models` finds exactly five
quoted pins beyond the members — project.go:95 `'board_type'`,
team.go:82 `'authorize'`, and the three member pins; ours carries
`board_type` (schema.ts:3032) and `authorize` (schema.ts:2244) verbatim,
so no miss. (c) The lowercase-first-token sweep (`xorm:"<lowercase>
…"` non-type tokens): metadata_json, url, http_method, ephemeral,
is_disabled, has_cancelling_support, content_encoding, two_factor_policy,
expiry, uuid, lfs_enabled, lfs_endpoint, last_error, setting_value —
every pin ours carries matches verbatim (one schema.ts hit each);
`expiry` (session.go:18) belongs to the recorded sessions redesign
(SPEC-0010, §7.5). Net: the sweep found exactly two same-class misses,
both now members 17-18; the census RENAME inventory is otherwise complete.

**3. Blast radius — per-member counts (the property-kept contract makes
every member a cheap-rename).** Drizzle property sites are INFO (the
contract keeps them — zero application-code edits); the MUST-EDIT column
is raw-SQL name sites outside schema.ts. Production source has ZERO
raw-SQL column bindings for any member (the drizzle-only route rule
held): every string hit for these names outside schema.ts is an
upstream-parity HTTP surface that stays — the `?rule_name=` query param
and the transfer form's `team_ids` key (upstream's own form keys), the
merge `merge_message_field` form key, the type-31 comment-meta content
JSON's `project_column_id` key (upstream content shape), and the
`[pull_id: …]` auto-merge error text (pulls.ts:1704, upstream's exact
string).

| member | drizzle property sites (src/test) | MUST-EDIT raw-SQL sites | verdict |
|---|---|---|---|
| 1 `new_owner_id` → `recipient_id` | `newOwnerId` 20/17 (drizzle-leg 3/1) | 1 — settings-danger-zone.matrix.test.tsx:120 INSERT | cheap-rename |
| 2 `team_ids` → `team_i_ds` | `teamIds` 43/14 | 0 | cheap-rename |
| 3 `allowlist_team_ids` → `_i_ds` | `allowlistTeamIds` 14/8 | 0 | cheap-rename |
| 4 `allowlist_user_ids` → `_i_ds` | `allowlistUserIds` 14/11 | 0 | cheap-rename |
| 5 `rule_name` → `branch_name` | `ruleName` 90/52 (drizzle-leg 3/7) | 1 — bench-d1.test.ts:2144 SELECT | cheap-rename |
| 6 `rules` → `config` | row/set keys ~6 (branch-protection.ts:820,872,1113; branch-protections.ts:709,731,942) | 0 | cheap-rename |
| 7 `project_columns` → `project_board` | export `projectColumns` 49/41 — export name KEPT | 1 — bench-d1.test.ts:2198 FROM | cheap-rename |
| 8 `is_default` → `default` | `isDefault` 28/44 (drizzle-leg 2/0) | 0 | cheap-rename |
| 9 `project_column_id` → `project_board_id` | `projectColumnId` 12/18 (drizzle-leg 6/3) | 0 (the JSON-key hits are content shape, stay) | cheap-rename |
| 10-11 `event`/`filters` → `workflow_*` | `projectWorkflows.event` 1/0; filters/actions ride zod objects | 0 | cheap-rename |
| 12 `actions` → `workflow_actions` | (same surface as 10-11) | 0 | cheap-rename |
| 13 `seconds` → `time` | `trackedTimes.seconds` 12/4 | 6 — schema.test.ts:1454-1479 INSERTs | cheap-rename |
| 14 `issues.title` → `name` | `issues.title` 17/13 (3 src are drizzle sql`` interpolations — auto-follow) | 14 — `INTO issues (… title …)` fixtures (activity-feeds.test.tsx:98 et al.) | cheap-rename (largest fixture tail) |
| 15 `pull_auto_merges.issue_id` → `pull_id` | `pullAutoMerges.issueId` 7/2 | 0 (the error-text hit stays) | cheap-rename |
| 16 `merge_message` → `message` | `mergeMessage` 13 (pull-automerge.ts + its fixtures) | 0 | cheap-rename |
| 17 `audit_event.created_unix` → `timestamp_unix` | `auditEvents.createdUnix` (audit.ts keyset/list, drizzle) | 4 — audit.test.ts:130 INSERT + :417,:436,:442 EXPLAIN witnesses | cheap-rename |
| 18 `review_state.issue_id` → `pull_id` ★ | `reviewState.issueId` 4 (pull-files.tsx:843-873) | 1 — schema.test.ts:1045 INSERT | cheap-rename |

Total MUST-EDIT: ~26 raw-SQL fixture lines across 6 test files. Every
member is a cheap-rename under the contract; none warrants an own-unit
split. The one optional ours-side follow-up: FN-7 (which rides this
batch) may rename the `pullAutoMerges.issueId`/`reviewState.issueId`
PROPERTIES to match their new columns — ours-side ergonomics, not part
of FN-5's DDL contract.

**4. The migration shape — drizzle-kit DOES generate RENAME COLUMN
(trial + dist evidence; never the repo's real schema).** Trial:
`/tmp/fn5-drizzle-trial` — a scratch schema mirroring three member
tables (repo_transfer + protected_branches with its unique index +
tracked_time), base migration generated with the workspace binary
(drizzle-kit 0.31.11), then the schema flipped to the after-state
(properties kept, explicit strings renamed) and generated again. Result:
the diff run DETECTS the renames and raises the interactive
"renamed-or-created" prompt per column (`promptColumnsConflicts`,
logging `~ old › new column will be renamed`); under a non-TTY stdin it
FAILS LOUD — "Interactive prompts require a TTY terminal" — it never
silently emits drop+add. Dist corroboration (drizzle-kit 0.31.11
bin.cjs): the SQLite convertor has a dedicated
`SQLiteAlterTableRenameColumnConvertor` emitting
`ALTER TABLE \`t\` RENAME COLUMN \`old\` TO \`new\`;` and
`ALTER TABLE \`t\` RENAME TO \`t2\`;` for the table rename; the sqlite
migration compiler orders `rename_table` statements first, then
`rename_column`, then the rest; indexes whose column lists change are
diffed as altered → DROP INDEX + CREATE INDEX under the new names (so
`protected_branches_repo_rule_uq` rebuilds around `branch_name`
automatically). VERDICT: the FN-5 migration is ALTERs-only — one
generated migration with 17 RENAME COLUMN + 1 RENAME TABLE + the one
index rebuild, no table rebuild and no data-copy staging (the FN-6/0066
rebuild lesson does not apply; SQLite ≥3.25/D1 support both ALTER forms
natively). Operational consequence for the port unit: `pnpm db:generate`
must run in an interactive TTY and answer the 18 rename prompts; CI has
no silent failure mode (it errors at the prompt). Post-generate gate:
eyeball the emitted file for ALTERs-only (no `CREATE TABLE`, no
`DROP COLUMN`), then `pnpm db:migrate:local` against a seeded dev D1 to
prove rows survive under their new names.

### 7.11 FN-9 disposition — the original_author family is intentional-recorded-absent (FN-9 unit GN, 2026-11-03)

The open question (§5's FN-9 row as dispatched): is the `original_author`
+ `original_author_id` family port-when-read or intentionally absent?
Both arms were derived from the tree's own records; the verdict below is
**intentional-recorded-absent**, and this §7.11 is the column-level
disposition (SPEC-0005 §9 is the SPEC carrier, per FN-13's supersession
rule — SPEC records own the divergence, ADR-0007's own test).

**1. The upstream writer matrix — one writer, five surfaces, importer
only.** Every write of the family is the `ExternalUserRemappable`
implementation on each struct (`models/user/external_login_user.go:72-76`
defines the interface), and every caller is the repo-migration
uploader's `remapUser` (`services/migrations/gitea_uploader.go:1007-1022`)
— the forge-metadata importer. No native create/edit path writes the
pair (grep over `models/ services/ routers/ modules/` at the pin: the
only `OriginalAuthor =` assignments are the five remaps plus
`InsertReviews`'s struct copy, review.go:668-669, itself reachable only
from the importer, gitea_uploader.go:975):

| upstream table | fields (cite) | writer | remapUser call sites |
|---|---|---|---|
| `issue` | issue.go:61-62 | `Issue.RemapExternalUser` issue.go:720-724 | gitea_uploader.go:432 (issue), :583, :815 (PR issue) |
| `comment` | comment.go:280-281 | `Comment.RemapExternalUser` comment.go:1279-1283 | gitea_uploader.go:549 (comment), :967 (review comment) |
| `review` | review.go:130-131 | `Review.RemapExternalUser` review.go:1086-1090 | gitea_uploader.go:897 (review) |
| `reaction` | reaction.go:69-70 | `Reaction.RemapExternalUser` reaction.go:91-95 | gitea_uploader.go:445 (issue), :559 (comment), :825 (PR) |
| `release` | release.go:74-75 | `Release.RemapExternalUser` release.go:495-499 | gitea_uploader.go:299 (release) |

**Lifecycle (the clear arm).** `remapUser` resolves the source author
first: a mapped LOCAL user writes `("", 0)` plus the local id
(`target.RemapExternalUser("", 0, userID)`, gitea_uploader.go:1020) — the
columns are actively CLEARED; an unmapped external author writes
`(externalName, externalID)` with `PosterID = g.doer.ID` (the migrating
user, :1022). After import nothing touches the pair again (no other
writer exists), so the "migrated-author" mark is permanent; `HasOriginalAuthor`
(comment.go:1295-1298, issue.go:736-739) reads it as name ≠ "" AND id ≠ 0.

**2. The upstream reader matrix — every arm keys off non-empty, and every
arm degrades to the plain local arm when the pair is `("", 0)`.**

- API renders: `ToAuthor`'s ghost fallback — originalAuthor "" → plain
  `ToUser(poster)` (services/convert/user.go:53-58), fed at
  convert/issue.go:53 (issue Poster), issue_comment.go:21,89 (comment
  Poster), pull_review.go:26,107 (review Reviewer / comment Poster),
  convert/release.go:31 (release Publisher), routers/api/v1/repo/
  issue_reaction.go:90,303 (reaction User).
- Web templates: `comments_authorlink.tmpl:1-4` + the avatar gate
  `comments_avatarlink.tmpl:1`; `comments.tmpl:19,31,34,360,401`,
  review name `:606-609`; issue header `view_content.tmpl:6,18,21`;
  issue-list/card last-event labels `shared/issuelist.tmpl:53-54`,
  `issue/card.tmpl:28-29`; reviewer sidebar `sidebar/reviewer_list.tmpl:96`;
  release list `release/list.tmpl:49`.
- Role/attribution gates: `roleDescriptor`'s `hasOriginalAuthor` arm —
  migrated posters get no role badge (routers/web/repo/issue_view.go:47-49,
  called :708, :808, :1127); `IsPoster` requires
  `OriginalAuthorID == 0` (issue.go:437-439); migrated PRs render with
  posterID 0 (issue_page_meta.go:384-385); label-comment merge guard
  compares the name (issue_view.go:234).
- Review aggregation: external reviewers keyed by `OriginalAuthorID`,
  ghost-id rows disambiguated by name (models/issues/review_list.go:181-192);
  review requests refused on migrated issues (`OriginalAuthorID == 0`
  gates, services/issue/review_request.go:90,102); feed reviewer name
  (services/feed/notifier.go:294-296).
- Reaction arms: `HasUser` guard (reaction.go:257-263, the check :262),
  user-id collection skips external rows (:278-282), `LoadUsers`
  fabricates the "name(ServiceType)" pseudo-user (newMigrationOriginalUser
  :287-290, used at :308-309), and the
  issue/comment DELETE arms carry `original_author_id = 0` so a doer
  cannot delete a migration-seeded row by id coincidence
  (reaction.go:221-233; the release arm has no guard, :247-251 — ours
  documents exactly this split, api/services/release-reactions.ts:108-112).

**3. Our surface — no writer can fire, and no reader exists.**

- Writer: our only migration surface is `POST /api/v1/repos/migrate`
  (SPEC-0009), which is git-data-only by record: SPEC-0009 §1 scopes it
  "git-data-only migration (no forge metadata)" and puts the forge-
  metadata migration (issues/PRs/labels/milestones/releases/reviews) in
  OUT-OF-SCOPE as a documented deferral (0009 §1, the first out-of-scope
  bullet); §2.2 makes the refusal contractual — `issues/milestones/
  labels/pull_requests/releases` set true answer `422` "metadata
  migration is not supported for this service" (:135-143), implemented
  `src/services/migrate.ts:185-194` and pinned by
  `src/services/migrate.test.ts:574`. No other spec, ledger row, roadmap
  row, or open question schedules the importer (grep over `specs/ docs/`:
  SPEC-0009 is the sole mention; its §6 open questions track push mirrors
  and webhook naming, not metadata migration; milestones M1-M4 contain
  none).
- Reader: grep 0 — no `originalAuthor` read in `src/api/`, `src/services/`,
  `src/git-http/`; renders go straight to the poster row
  (`toPoster`, api/services/issues.ts:259-267, feeding the issue render
  :726 and the comment renders :879, :1343, :1417) with no ghost arm.
- Presence: `issues` already carries the pair UNWRITTEN
  (schema.ts:676-678, "Mirrored importer fields");
  `pull_reviews`' table docstring already RECORDS the omission ground for
  its table ("no cf-gitea migration surface writes reviews",
  schema.ts:2491-2493); `comments`/`reactions`/`releases` carry no
  counterpart (§4 rows, unchanged).

**4. Verdict: intentional-recorded-absent.** Ground, explicitly: (a) the
columns' only writer is the forge-metadata migration importer (§7.11 §1 —
every write path flows through `remapUser`); (b) our surface has no
importer and its single entry point refuses metadata migration with `422`
(SPEC-0009 §1/§2.2, implemented + tested); (c) no tree record schedules
the importer — the deferral carries no SPEC number, no open-question
entry, no milestone; (d) observable parity holds at the empty-columns arm:
100% of our rows are locally authored, every upstream reader falls to the
plain local arm when the pair is `("", 0)` (§7.11 §2), and `ToAuthor("")`
≡ `ToUser(poster)` — the render ours ships today. Porting the pair now
would add permanently-NULL/0 state whose writer never runs: port-when-read
and recorded-absent collapse into the same trigger (a reader needs
non-empty values only if imported content exists), so the honest
classification is the one that CLOSES the backlog row rather than parks
it. The port trigger is named regardless: if the forge-metadata migration
surface is ever SPEC'd (a SPEC-0009 extension), THAT SPEC owns the family
— additive NULLable pairs on `comment`/`review`/`reaction`/`release`
(plus verifying the `issues` twin), the `remapUser`-equivalent writer,
and the reader arms below. FN-9 is not a waiting unit.

**5. The trigger rider (what the importer SPEC would carry; our landing
points, pre-derived):** the `ToAuthor` ghost arm rides the poster render
seams (issues.ts:259-267 + the four call sites above; reviews
api/routes/pull-reviews.ts:458 `ToPullReview`; releases
api/services/releases.ts:961-963 — ours already Ghost-renders missing
publishers); the reaction DELETE arms gain upstream's
`original_author_id = 0` guard (reaction.go:221-233; ours is guardless
today, api/services/issue-extras.ts:116-132 — vacuously correct while the
column is absent); the reactions dedup key widens by the pair (upstream's
UNIQUE(s) spans 7 columns, reaction.go:65-71 — the :63-70 this block
landed with straddled the pk and missed `type`, corrected by the §7.9
cite-audit); ours
`onConflictDoNothing` targets 5, issue-extras.ts:109-110,
release-reactions.ts:105-109); the role/attribution gates port only with
the web surfaces they serve. This is a rider on the future SPEC, not a
plan — nothing here is scheduled.

**6. The `issues` twin (present-but-unwritten) is NOT dead drift —
recorded RESERVED.** Ground: (a) the same no-importer record (§7.11 §3);
(b) the house precedent — SPEC-0009 already creates columns ahead of
their writer and calls it out (`lfs_enabled`/`lfs_endpoint` "created now
and reserved", 0009 §1 + §3.1 table row); (c) the schema comment already
names the ground ("Mirrored importer fields", schema.ts:676) and
SPEC-0005 §3.2's DDL line carries the pair (:503-504). SPEC-0005 §9
records it normatively. No removal: dropping two NULL columns costs a
table-rebuild migration to delete state that costs nothing and that the
importer SPEC would re-add. No flag for the next schema unit beyond the
SPEC record itself.

**7. Census-owner flags — ACTED by the §7.9 cite-audit (2026-11-03).**
With this record standing, the three tables whose ONLY §4 drift lines
are this family were reclassified drift → intentional-recorded:
`review` (§4), `reaction` (§4), `release` (§4) — each §4 subsection and
§3.1 row now carries the flip with the recorded-absent reason; `comment`
keeps its drift verdict on FN-2's five remaining columns. The Headline
tally moved 46/23/26/22 → 46/26/23/22 and was re-grepped from the §3.1
table at landing: 46 + 26 + 23 + 22 = 117 ✓ (ours-extras 12 unchanged).
The §4 subsections' missing-column off-by-one cites are corrected
(review.go:131-132 → :130-131; reaction.go:70-71 → :69-70;
release.go:75-76 → :74-75 — field lines re-verified at the pin by the
cite-audit); the FN-9 backlog row's cites are corrected in place
(see §5).

**8. FN-2's decision point resolves.** SPEC-0005 §7.2's land-or-defer
choice and §7.7's open item close on DEFER: the pair stays out of FN-2's
migration, and the "family carrier" FN-9 named there is this record, not
a future port unit. The FN-2 port unit's SPEC record cites SPEC-0005 §9.

### 7.12 FN-8 derivation — `commit_statuses.context_hash` + `index`: upstream semantics, ours surface, the id-semantics blast radius, and the port plan (FN-8-prep unit, 2026-11-04)

Closes the FN-8 row's owed derivation. Everything below was re-verified
with my own eyes at the pin `fc4936884584` (both sides). The plan carrier
is **SPEC-0005 §10 — PLAN ONLY** (nothing built; the FN-8 row's status
points there). Zero code was written by this unit.

**1. The upstream derivation — what each column IS, who writes it, who
reads it.**

- **Struct** (models/git/commit_status.go:37-57): `Index int64
  xorm:"INDEX UNIQUE(repo_sha_index)"` (:41 — a standalone index PLUS the
  named composite unique over repo_id, sha, index) and `ContextHash
  string xorm:"VARCHAR(64) index"` (:50 — standalone index). Neither tag
  carries NOT NULL (contrast :40 `SHA … VARCHAR(64) NOT NULL`); both are
  nullable at the tag level — the plan mirrors that posture.
- **The writer** — `NewCommitStatus` (:497-537) runs inside ONE
  `db.WithTx` (:506-536): it first calls `GetNextCommitStatusIndex
  (repoID, sha)` (:508), assigns `opts.CommitStatus.Index = idx` (:520),
  then inserts. `GetNextCommitStatusIndex` (:125-181) validates the sha
  (:126-129) and bumps the per-(repo, sha) `max_index` counter in the
  `commit_status_index` table (:329-335: ID, RepoID `unique(repo_sha)`,
  SHA `unique(repo_sha)`, MaxIndex `index`) — one arm per dialect
  (postgres upsert+RETURNING :64-75, mysql :77-94, mssql :96-122) plus
  the sqlite default (UPDATE-then-INSERT slow path :140-181). **The
  per-sha ordinal is 1-based MAX+1**: the first status of a sha gets
  index 1 (postgres arm inserts VALUES(?,?,1) on the miss :65-67; sqlite
  arm inserts 0 then UPDATE+1 :153-154), so the counter RESTARTS per
  (repo, sha) — it is not the row pk's global sequence.
- **ContextHash semantics** (:50 + :546-552): `HashCommitStatusContext`
  = lowercase hex sha1 of the context string (:550-552). `NewCommitStatus`
  derives it from `Context` when the caller left it empty (:526-528);
  callers MAY pre-compute to split same-display-Context rows — the
  Actions writer mixes the workflow file path in
  (`HashCommitStatusContext(ctxName + "\x00" + workflowID)`,
  services/actions/commit_status.go:282, issue #35699, with the
  legacy-hash adoption reader :288-302 that adopts the pre-#35699
  Context-only hash from an in-flight Actions-owned row so the stale
  pending status still gets superseded). **The column is
  internal-only**: no json tag anywhere on the struct, absent from the
  API wire (`structs.CommitStatus`, modules/structs/status.go:13-32) and
  from the webhook payload (`CommitStatusPayload`,
  modules/structs/hook.go:647-673) — its ONLY observable is the
  latest-per-context grouping it keys, plus the internal adoption-arm
  comparison.
- **The reader surfaces**:
  - API serializer: `ToCommitStatus` sets `ID: status.Index`
    (services/convert/status.go:24) — **the REST `id` field IS the
    per-sha index, not the row pk**.
  - List ordering: `CommitStatusOptions.ToOrders` (:312-327) — every
    order terminates in `` `index` `` (default
    `` created_unix DESC, `index` DESC `` with the load-bearing comment
    "timestamps have 1s resolution, `index` keeps paging stable"
    :325); the inverted names (`leastindex` → `` `index` DESC ``,
    `highestindex` → `` `index` ASC ``, :320-323) are pinned-faithful in
    ours (api/services/commit-status.ts:16-18). Upstream backtick-quotes
    `` `index` `` in every SQL surface (:315-325, :346, :357) — SQLite
    reserved word, our port quotes it identically.
  - Latest-per-context reads: `GetLatestCommitStatus` (:343-359 —
    `` max(`index`) `` GROUP BY context_hash, then fetch rows by those
    indices), `CountLatestCommitStatus` (:361-366), `ForPairs` (:369-422),
    `ForRepoCommitIDs` (:426-472). Pin observation: the second fetch in
    `GetLatestCommitStatus` carries NO ORDER BY (:357) — the emitted
    array order is engine-dependent; ours orders desc (a pre-existing
    recorded choice, commit-status.ts:229) — state parity is unaffected
    (`Combine` is order-insensitive; our combined arm renders no
    target_url), left as-is.
  - PR merge-box rollup: `routers/web/repo/pull.go:413-414`
    (GetLatestCommitStatus at the PR head) + `MergeRequiredContextsCommitStatus`
    (services/pull/commit_status.go:19-71, the GetLatestCommitStatus
    caller :142) over the raw latest-per-context rows; the dashboard/
    commit-list surfaces read the same raw rows (web view.go:142,
    commit.go:386 — §3.3's cites).
  - **The webhook payload `id` is the ROW PK** — `ID: status.ID`
    (services/webhook/notifier.go:942, field hook.go:659). Upstream
    itself carries the asymmetry: REST id = Index, webhook id = pk.
- **Upstream's own backfill precedents** (both shipped as migrations):
  - context_hash: `AddCommitStatusContext` (modelmigration/v1_10/v88.go:18-66)
    — Sync the column, then backfill `hashContext(status.Context)` in
    id-ordered batches (the sha1-of-Context default, exactly what
    NewCommitStatus would have written).
  - the counter table: `AddTableCommitStatusIndex`
    (modelmigration/v1_16/v195.go:16-46) — create `commit_status_index`,
    then seed `max(commit_status.index) GROUP BY repo_id, sha` so the
    counter RESUMES from the max existing index per sha.

**2. Ours surface (working-tree, 2026-11-04).**

- Schema: `commit_statuses` sits at schema.ts:1256-1279 (working-tree
  2026-11-04; the audit-time cite :1066 drifted and the block moves
  under concurrent schema edits — re-grep at landing; census row
  re-cited) — global
  autoincrement `id` pk, NO `context_hash`, NO `index`; the only index is
  `commit_statuses_repo_sha_idx (repo_id, sha)` (schema.ts:1274 at the
  same working-tree snapshot).
- The REST id: `id: row.id` (api/services/commit-status.ts:97) —
  **divergent from upstream's `ID: status.Index`**. The TODO the audit
  row names, verbatim: "`id` carries the per-sha status INDEX (our D1
  table has no index column — the autoincrement id takes its place;
  TODO(SPEC-0005): commit_status_index)" (commit-status.ts:87-93), and
  the insert-side twin "upstream's separate `commit_status_index` counter
  (per-sha monotonic index) has no D1 counterpart yet — the autoincrement
  id doubles as the sort/aggregation key (module comment)"
  (:142-147). The module comment records the standing reduction: "`context`
  groups 1:1 with its hash, and the global autoincrement `id` is
  order-equivalent to the per-sha index within one (repo, sha)"
  (:27-30).
- Dedupe/lookup shape: `latestCommitStatuses` groups by the RAW
  `context` with `max(id)` per group (:210-238) — where upstream groups
  by context_hash with `` max(`index`) ``.
- The webhook emit: `routes/statuses.ts:313-325` builds
  CommitStatusPayload with `id: row.id` (:318) — **already
  upstream-faithful** (upstream webhook id is the pk too); NO change.
- The second writer: Actions `createWorkflowCommitStatus`
  (services/actions/trigger.ts:2160-2197) — dedupes by
  `eq(context, ctxName)` + `orderBy(desc(id))` (:2166-2168) and inserts
  without hash/index; its module header discloses the reduction
  (:119-121: two same-named workflows sharing a job name supersede each
  other here where upstream keeps both; the legacy-adoption arm
  "unreachable").
- Downstream consumers of the reads (no direct id use):
  `mergeRequiredContextsCommitStatus` (services/branch-protection.ts:830-906,
  the merge gate) and its auto-merge twin (services/pull-automerge.ts:198-262,
  pages latestCommitStatuses at :233-245); the repo-list
  `latest_commit_status` (ui/pages/search-aux.ts:586); the repo-delete
  cascade (repos/service.ts:1106).

**3. The id-semantics blast-radius table — every pin the flip touches.**

| surface | ours today | after the port | upstream at the pin | pinned tests |
|---|---|---|---|---|
| REST `CommitStatus.id` (POST 201 body; list items; `combined.statuses[].id`) | row pk (commit-status.ts:97) | per-sha index (the flip) | Index (convert/status.go:24) | statuses.test.ts:184,189 assert type-only (`typeof === "number"`, `Number.isInteger`) — survive; NEW pins: first status of a sha → 1, ordinal increments, RESTARTS across shas, `id` ≠ row pk |
| Webhook `CommitStatusPayload.id` | row pk (statuses.ts:318) | row pk — UNCHANGED | pk (notifier.go:942, hook.go:659) | statuses.test.ts:630-641 asserts the field SET (id present, emit test :609) — survives; NEW pin: webhook id = pk ≠ REST id (upstream's own asymmetry) |
| List sort orders (`sort=` five values + default) | `id` as the index stand-in (commit-status.ts:39-56) | column `index` (same observable through the writer; raw seeds must carry index) | ToOrders :312-327 (inverted names :320-323 kept) | statuses.test.ts:296-312 (default order) + :314-334 (the `it.each` sort matrix) seed RAW rows whose order relies on "ids a<b<c" doubling as index order — MUST-EDIT (seed `index`) |
| Latest-per-context grouping (combined + gates) | `max(id)` per raw `context` (commit-status.ts:219-223) | `` max(`index`) `` per `context_hash` | :343-359 | combined tests statuses.test.ts:421-433 (shape), :444-468 (precedence matrix), :470-483 (latest-per-context) seed raw rows — MUST-EDIT (seed hash + index); branch-protection.test.ts:476,606 raw seeds — MUST-EDIT (NULL context_hash would collapse ALL rows into one NULL group under GROUP BY, and NULL `index` breaks max) |
| Combined `total_count` / `X-Total-Count` | count of context groups (:232-237) | count of context_hash groups | :361-366 | same fixtures as above |
| Actions writer dedupe | raw context + identical-state short-circuit (trigger.ts:2166-2172) | mixed hash group + legacy-adoption arm + counter | actions/commit_status.go:282-302 | trigger.test.ts:1678-1697 (identical-state short-circuit; onlyReplace) — survive via the writer; NEW pin: two same-named workflows (different paths) now keep separate groups (#35699 observable) |
| Merge gates (branch-protection / pull-automerge) | consume latestCommitStatuses rows | unchanged call sites — the swap is service-internal; observable grouping identical for API-created rows | pull/commit_status.go:19-71,142 | branch-protection.test.ts fixtures edited (above); pull-automerge.test.ts builds row objects in memory (no D1 seeds) — verify shapes gain hash/index |
| Repo-list `latest_commit_status` (UI search-aux) | latestCommitStatuses (search-aux.ts:586) | unchanged call site | view surface | no direct id pins (grep: no commitStatuses hits in pages-wave18.test.ts) |
| Repo delete cascade | deletes commit_statuses rows (repos/service.ts:1106) | + delete commit_status_indexes rows for the repo | upstream cascades via FK-free per-table deletes | schema.test.ts / repository.test.ts delete sweep — extend |

Pipes note: `status` webhook deliveries carry no `context_hash`/
`index` — the wire payloads' field SETS are unchanged on every surface
(REST contract field set pinned at statuses.test.ts:175; webhook field
set at :630-641, inside the emit test :609).

**4. The migration shape (drizzle-kit, one generated migration +
one application-side hash pass).**

- ADD COLUMN x2 on `commit_statuses`, mirroring the tags' nullable
  posture: `context_hash` VARCHAR(64) + `index` INTEGER (the column NAME
  is upstream's `index` — a SQLite reserved word: drizzle quotes every
  identifier, and all raw SQL in the port quotes it like upstream's own
  backticks; schema property `index` needs no rename under the §7.10
  Go-field-maps-to-property convention). Plain `ALTER TABLE ADD COLUMN`
  — no table rebuild.
- Backfill `index` (pure SQL — D1-doable): per-sha 1-based creation
  ordinal, correlated-count form,
  `` UPDATE commit_statuses SET "index" = (SELECT COUNT(*) FROM commit_statuses c2 WHERE c2.repo_id = commit_statuses.repo_id AND c2.sha = commit_statuses.sha AND c2.id <= commit_statuses.id) ``
  (order-equivalent to `ROW_NUMBER() OVER (PARTITION BY repo_id, sha
  ORDER BY id ASC)`). **Derivation**: upstream's index IS the 1-based
  per-sha creation ordinal (:497-521 + counter :329-335; first row = 1,
  :65-67/:153-154), and within one (repo, sha) creation order ascends
  with our global autoincrement id — the id is the creation-order oracle
  our table already carries, exactly the reduction the module comment
  records (commit-status.ts:27-30); created_unix cannot do this job
  (1-second resolution — upstream's own reason for the column, :325).
  Cost: O(n²) worst-case per sha group; commit_statuses tables are small
  per sha (CI statuses), acceptable for a one-shot migration.
- Seed the NEW `commit_status_indexes` table (name per the §7.5
  pluralization family — upstream singular `commit_status_index`, the
  same recorded pattern that made `commit_status` → `commit_statuses`):
  `INSERT … SELECT repo_id, sha, max(index) … GROUP BY repo_id, sha` —
  **upstream's own v195 seed shape** (v195.go:39-44), so the counter
  resumes instead of restarting.
- Backfill `context_hash` — NOT expressible as pure D1 SQL (SQLite core
  has no sha1(); the value MUST be sha1-hex because the writers compute
  exactly that — a different backfill function would split dedupe groups
  between migrated and new rows). Two arms, plan takes (b): (a) a
  self-host one-off script (wrangler d1 execute cannot compute sha1
  either — it would have to be a Worker-invoked pass); **(b) the
  opportunistic lazy repair** — every writer path computes
  `sha1(context)` (WebCrypto `digest("SHA-1")` is available in Workers)
  for new rows, and the read path repairs NULL-hash rows it encounters
  (bounded by page size, `ctx.waitUntil` for the UPDATEs) — the same
  opportunistic-trigger posture §3.3 records for commit_status_summary.
  Convergence note: unrepaired rows keep grouping under SQL's NULL group
  (SQLite GROUP BY treats NULLs as one group), so an unrepaired row
  dedupes exactly as the pre-port raw-context rows do — observable
  behavior degrades to today's, never worse.
- Enforcement after backfill: `CREATE UNIQUE INDEX
  commit_statuses_repo_sha_index_uq ON commit_statuses (repo_id, sha,
  "index")` + standalone `CREATE INDEX … ( "index" )` and `CREATE INDEX
  … (context_hash)` — the three structures upstream's tags declare
  (:41 composite UNIQUE + standalone INDEX; :50 context_hash index).
  Index-FORM, not table-constraint: D1 `ADD COLUMN` cannot add table
  constraints, and a SQLite UNIQUE table constraint over existing+new
  columns would force a table rebuild (the FN-6/0066 lesson); SQLite
  treats a unique index identically for enforcement, and NULLs are
  distinct in unique indexes, so un-backfilled rows never violate.
- Gate: post-generate eyeball (ALTERs + CREATE INDEX/TABLE only, no
  DROP COLUMN), `pnpm db:migrate:local` against a seeded dev D1, and the
  `index` backfill verified against the per-sha row counts.

**5. The writer threading + the flips (the port unit's work list).**

- `commit_status_indexes` drizzle table (mirrors CommitStatusIndex
  :329-335): autoincr id, repoId, sha, maxIndex, `unique(repo_id, sha)`.
- Index allocation: drizzle-native upsert —
  `.insert(commitStatusIndexes).values({…, maxIndex: 1})
  .onConflictDoUpdate({ target: [repoId, sha], set: { maxIndex: sql`max_index + 1` } })
  .returning()` — the POSTGRES arm's shape (:64-75), one statement,
  atomic under SQLite's write lock; counter + insert ride ONE D1 batch
  (upstream's single WithTx, :506-536); a crash between the pair burns
  an ordinal, harmless (upstream identical).
- API POST (routes/statuses.ts:384-392 + createCommitStatus): allocate,
  store `index` + `contextHash = sha1(context)`; the response renders
  `id: row.index` (commit-status.ts:97 flips — the TODO block :87-93 and
  :142-147 dissolve into parity notes).
- Reads: `commitStatusOrderBy` swaps id → index (:39-56);
  `latestCommitStatuses` swaps to max(index) per context_hash (:210-238).
- Actions writer (trigger.ts:2160-2197): compute the mixed hash
  `sha1(ctxName + "\x00" + workflowId)` (actions/commit_status.go:282), add the
  legacy-adoption arm (:288-302 — adopt when the latest row for the sha
  carries the legacy hash, same context, and creator is the Actions
  user), allocate `index`, keep the identical-state short-circuit per
  mixed-hash group. The :119-121 reduction disclosure is deleted with
  the column landing.
- Repo delete sweep gains the new table (repos/service.ts:1106).
- Test battery (names, no code): "POST assigns per-sha ordinals 1,2,…;
  a second sha restarts at 1"; "REST id differs from the webhook
  payload id for the same row"; "sort=highestindex orders by index ASC
  with seeded indices (not ids)"; "latest-per-context groups by
  context_hash, not raw context"; "backfill migration reconstructs
  ordinals from seed order (fixture: 3 rows, shuffled ids within one
  second)"; "counter seed resumes at max(index)"; "actions: two
  same-named workflows keep separate latest rows at one sha";
  "actions: a pre-port legacy-hash row is adopted and superseded".

**6. Census-owner notes.** Census row 221 re-cited (schema.ts:1066 →
:1256, working-tree 2026-11-04; the ours-cite moves under concurrent
schema edits — re-grep at landing) and carries the DERIVED pointer; row
222 (commit_status_index) carries the plan pointer; the §4 subsection is
expanded with both columns' semantics. The port unit flips rows
221 (`drift` → `aligned`) and 222 (`missing-table` → `aligned`) at
landing, and dissolves the TODO cites in row 222. SPEC-0005 §10 is the
normative plan carrier; SPEC-0004 §2.4's status rows (:270-272) get the
id-semantics note at port time.

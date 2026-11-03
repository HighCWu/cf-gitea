-- Custom SQL migration file, put your code below! --
-- ADR-0007 FN-5: the gonic-quirk + project rename batch (SPEC-0005 §8
-- as-built; the audit's §7.10 member table). Upstream pin fc49368845's
-- literal DDL names adopted by RENAME only — drizzle properties and table
-- export names are KEPT (the property-kept contract: zero application-code
-- edits) and every row carries over (SQLite >= 3.25 ALTER forms, native in
-- D1; no rebuild, no data copy — the FN-6/0066 rebuild lesson does not
-- apply). Hand-authored per the 0064 --custom precedent: drizzle-kit's
-- rename detection needs an interactive TTY (non-TTY fails loud, never a
-- silent drop+add), so the deterministic ALTER set is written directly, and
-- the 0069 snapshot was hand-moved to the post-rename state (the --custom
-- generate copies the previous snapshot verbatim; the next diff must see
-- only FN-7's additive column).
--
-- Statement order mirrors drizzle-kit's compiler: rename_table first, then
-- the 17 rename_column statements, then the one index rebuild. RENAME COLUMN
-- re-points every index referencing the renamed column in place; the
-- DDL-visible rebuild (drop + create under the unchanged index name
-- protected_branches_repo_rule_uq, now over `branch_name`) matches the
-- drizzle-kit-canonical emitted shape for an altered index.

-- Member 6: the table rename (upstream ProjectBoard's TableName() override,
-- models/project/column.go:66-68).
ALTER TABLE `project_columns` RENAME TO `project_board`;--> statement-breakpoint

-- The 17 column renames (§8.1 members 1-5, 7-18; cites in the audit table).
ALTER TABLE `repo_transfer` RENAME COLUMN `team_ids` TO `team_i_ds`;--> statement-breakpoint
ALTER TABLE `repo_transfer` RENAME COLUMN `new_owner_id` TO `recipient_id`;--> statement-breakpoint
ALTER TABLE `protected_tags` RENAME COLUMN `allowlist_team_ids` TO `allowlist_team_i_ds`;--> statement-breakpoint
ALTER TABLE `protected_tags` RENAME COLUMN `allowlist_user_ids` TO `allowlist_user_i_ds`;--> statement-breakpoint
ALTER TABLE `protected_branches` RENAME COLUMN `rule_name` TO `branch_name`;--> statement-breakpoint
ALTER TABLE `protected_branches` RENAME COLUMN `rules` TO `config`;--> statement-breakpoint
ALTER TABLE `project_board` RENAME COLUMN `is_default` TO `default`;--> statement-breakpoint
ALTER TABLE `project_issues` RENAME COLUMN `project_column_id` TO `project_board_id`;--> statement-breakpoint
ALTER TABLE `project_workflows` RENAME COLUMN `event` TO `workflow_event`;--> statement-breakpoint
ALTER TABLE `project_workflows` RENAME COLUMN `filters` TO `workflow_filters`;--> statement-breakpoint
ALTER TABLE `project_workflows` RENAME COLUMN `actions` TO `workflow_actions`;--> statement-breakpoint
ALTER TABLE `tracked_time` RENAME COLUMN `seconds` TO `time`;--> statement-breakpoint
ALTER TABLE `issues` RENAME COLUMN `title` TO `name`;--> statement-breakpoint
ALTER TABLE `pull_auto_merges` RENAME COLUMN `issue_id` TO `pull_id`;--> statement-breakpoint
ALTER TABLE `pull_auto_merges` RENAME COLUMN `merge_message` TO `message`;--> statement-breakpoint
ALTER TABLE `audit_event` RENAME COLUMN `created_unix` TO `timestamp_unix`;--> statement-breakpoint
ALTER TABLE `review_state` RENAME COLUMN `issue_id` TO `pull_id`;--> statement-breakpoint

-- The index rebuild: protected_branches' unique pair follows branch_name
-- (protected_branch.go:34's UNIQUE(s) over (repo_id, branch_name)); the
-- index NAME stays ours per the contract.
DROP INDEX `protected_branches_repo_rule_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `protected_branches_repo_rule_uq` ON `protected_branches` (`repo_id`,`branch_name`);

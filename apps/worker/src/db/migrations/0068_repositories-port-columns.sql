ALTER TABLE `repositories` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `description` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `website` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `avatar` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `archived_unix` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `default_wiki_branch` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `git_size` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `is_fsck_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `lfs_size` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_action_runs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_closed_action_runs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_closed_projects` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_projects` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `object_format_name` text DEFAULT 'sha1' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `original_service_type` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `template_id` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `topics` text;--> statement-breakpoint
ALTER TABLE `repositories` ADD `trust_model` text;--> statement-breakpoint
CREATE INDEX `repositories_template_id_idx` ON `repositories` (`template_id`);

-- ADR-0007 FN-4 backfills (SPEC-0001 §4.1; the 0064/0067 hand-appended
-- data-statement precedent). The three REAL recoverable values ride the
-- migration; counters and sizes stay 0 (constant DEFAULT = the one-time
-- settle posture — the num_stars precedent).

-- Backfill 1: name ← slug (fold 1). Upstream keeps a display-case `Name` and
-- a folded `LowerName`; ours stores the folded slug only, so the display case
-- for pre-0068 rows is UNRECOVERABLE — the slug copy is the recorded
-- best-effort backfill (SPEC-0001 §4.1 fold 1). New creates/renames stamp the
-- real display case.
UPDATE `repositories` SET `name` = `slug`;--> statement-breakpoint

-- Backfill 2: description/website ← repo_settings (the columns' value source
-- until this port; api/services/repository.ts rendered
-- `settings?.description ?? ""` / `settings?.website ?? ""`). Rows with a
-- settings row take its values (the create seed writes ''); rows without one
-- keep NULL — the render folds NULL to "" exactly like upstream's empty
-- TEXT column.
UPDATE `repositories`
SET `description` = (SELECT `rs`.`description` FROM `repo_settings` `rs` WHERE `rs`.`repo_id` = `repositories`.`id`),
    `website` = (SELECT `rs`.`website` FROM `repo_settings` `rs` WHERE `rs`.`repo_id` = `repositories`.`id`)
WHERE EXISTS (
  SELECT 1 FROM `repo_settings` `rs` WHERE `rs`.`repo_id` = `repositories`.`id`
);--> statement-breakpoint

-- Backfill 3: topics ← repo_topics recount — upstream's own
-- syncTopicsInRepository shape (models/repo/topic.go:340-352): the join's
-- names, `topic` ASC (upstream `.Asc("topic.name")`), stored as the JSON
-- array on the row. json_group_array over the ordered projection preserves
-- that order; an aggregate over zero rows answers NULL, so COALESCE pins the
-- upstream empty-slice serialization '[]' for topic-less repos.
UPDATE `repositories`
SET `topics` = COALESCE(
  (
    SELECT json_group_array(`rt`.`topic`)
    FROM (
      SELECT `topic` FROM `repo_topics` WHERE `repo_id` = `repositories`.`id` ORDER BY `topic` ASC
    ) AS `rt`
  ),
  '[]'
);

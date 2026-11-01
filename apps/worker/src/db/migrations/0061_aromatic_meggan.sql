ALTER TABLE `repo_transfer` ADD `team_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_closed_milestones` integer DEFAULT 0 NOT NULL;
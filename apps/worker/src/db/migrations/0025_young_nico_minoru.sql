CREATE TABLE `protected_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`name_pattern` text NOT NULL,
	`allowlist_user_ids` text DEFAULT '[]' NOT NULL,
	`allowlist_team_ids` text DEFAULT '[]' NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `protected_tags_repo_idx` ON `protected_tags` (`repo_id`);
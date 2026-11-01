CREATE TABLE `deleted_branches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`name` text NOT NULL,
	`commit_id` text NOT NULL,
	`deleted_by_id` integer NOT NULL,
	`deleted_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deleted_branches_repo_name_uq` ON `deleted_branches` (`repo_id`,`name`);--> statement-breakpoint
CREATE INDEX `deleted_branches_repo_idx` ON `deleted_branches` (`repo_id`);--> statement-breakpoint
CREATE TABLE `pull_auto_merges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`doer_id` integer NOT NULL,
	`sha` text NOT NULL,
	`merge_style` text NOT NULL,
	`delete_branch_after_merge` integer DEFAULT false NOT NULL,
	`merge_message` text,
	`created_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_auto_merges_issue_uq` ON `pull_auto_merges` (`issue_id`);--> statement-breakpoint
CREATE INDEX `pull_auto_merges_created_idx` ON `pull_auto_merges` (`created_unix`);--> statement-breakpoint
CREATE TABLE `review_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_state_user_issue_uq` ON `review_state` (`user_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `review_state_issue_idx` ON `review_state` (`issue_id`);--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`secret` text NOT NULL,
	`scratch_salt` text NOT NULL,
	`scratch_hash` text NOT NULL,
	`last_used_passcode_period` integer DEFAULT 0 NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `two_factor_uid_uq` ON `two_factor` (`user_id`);
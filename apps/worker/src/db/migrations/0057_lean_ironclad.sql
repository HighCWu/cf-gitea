CREATE TABLE `issue_user` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`is_mentioned` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_user_uid_issue_uq` ON `issue_user` (`user_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_user_issue_idx` ON `issue_user` (`issue_id`);
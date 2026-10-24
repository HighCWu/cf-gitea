CREATE TABLE `notification_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`read_at_unix` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_states_user_issue_uq` ON `notification_states` (`user_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `notification_states_user_idx` ON `notification_states` (`user_id`);
CREATE TABLE `action` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`op_type` integer NOT NULL,
	`act_user_id` integer NOT NULL,
	`repo_id` text NOT NULL,
	`comment_id` integer DEFAULT 0 NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`ref_name` text DEFAULT '' NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`created_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `action_repo_user_deleted_idx` ON `action` (`repo_id`,`user_id`,`is_deleted`);--> statement-breakpoint
CREATE INDEX `action_user_deleted_created_idx` ON `action` (`user_id`,`is_deleted`,`created_unix`);--> statement-breakpoint
CREATE INDEX `action_act_user_created_idx` ON `action` (`act_user_id`,`created_unix`,`user_id`);
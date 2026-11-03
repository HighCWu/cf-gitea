CREATE TABLE `action_schedule_spec` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`schedule_id` integer NOT NULL,
	`next` integer,
	`prev` integer,
	`spec` text DEFAULT '' NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `action_schedule_spec_repo_id_idx` ON `action_schedule_spec` (`repo_id`);--> statement-breakpoint
CREATE INDEX `action_schedule_spec_schedule_id_idx` ON `action_schedule_spec` (`schedule_id`);--> statement-breakpoint
CREATE INDEX `action_schedule_spec_next_idx` ON `action_schedule_spec` (`next`);--> statement-breakpoint
CREATE TABLE `action_schedule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`specs` text DEFAULT '[]' NOT NULL,
	`repo_id` text NOT NULL,
	`owner_id` integer NOT NULL,
	`workflow_id` text DEFAULT '' NOT NULL,
	`trigger_user_id` integer DEFAULT 0 NOT NULL,
	`ref` text DEFAULT '' NOT NULL,
	`commit_sha` text DEFAULT '' NOT NULL,
	`event` text DEFAULT '' NOT NULL,
	`event_payload` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `action_schedule_repo_id_idx` ON `action_schedule` (`repo_id`);--> statement-breakpoint
CREATE INDEX `action_schedule_owner_id_idx` ON `action_schedule` (`owner_id`);
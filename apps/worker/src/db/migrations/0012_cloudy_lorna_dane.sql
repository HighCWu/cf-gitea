CREATE TABLE `issue_assignees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`assignee_id` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_assignees_issue_assignee_uq` ON `issue_assignees` (`issue_id`,`assignee_id`);--> statement-breakpoint
CREATE INDEX `issue_assignees_assignee_idx` ON `issue_assignees` (`assignee_id`);--> statement-breakpoint
CREATE TABLE `issue_dependency` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`dependency_id` integer NOT NULL,
	`created_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_dependency_issue_dep_uq` ON `issue_dependency` (`issue_id`,`dependency_id`);--> statement-breakpoint
CREATE INDEX `issue_dependency_dependency_idx` ON `issue_dependency` (`dependency_id`);--> statement-breakpoint
CREATE TABLE `stopwatch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`created_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stopwatch_user_idx` ON `stopwatch` (`user_id`);--> statement-breakpoint
CREATE INDEX `stopwatch_issue_idx` ON `stopwatch` (`issue_id`);--> statement-breakpoint
CREATE TABLE `tracked_time` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`seconds` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`created_unix` integer
);
--> statement-breakpoint
CREATE INDEX `tracked_time_issue_idx` ON `tracked_time` (`issue_id`);--> statement-breakpoint
CREATE INDEX `tracked_time_user_idx` ON `tracked_time` (`user_id`);
CREATE TABLE `project_columns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`sorting` integer DEFAULT 0 NOT NULL,
	`color` text DEFAULT '' NOT NULL,
	`project_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_columns_project_id_idx` ON `project_columns` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_columns_created_idx` ON `project_columns` (`created_unix`);--> statement-breakpoint
CREATE INDEX `project_columns_updated_idx` ON `project_columns` (`updated_unix`);--> statement-breakpoint
CREATE TABLE `project_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`project_column_id` integer DEFAULT 0 NOT NULL,
	`sorting` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_issues_issue_id_idx` ON `project_issues` (`issue_id`);--> statement-breakpoint
CREATE INDEX `project_issues_project_id_idx` ON `project_issues` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_issues_column_id_idx` ON `project_issues` (`project_column_id`);--> statement-breakpoint
CREATE TABLE `project_workflows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`event` text DEFAULT '' NOT NULL,
	`filters` text DEFAULT '{}' NOT NULL,
	`actions` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_workflows_project_id_idx` ON `project_workflows` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`owner_id` integer DEFAULT 0 NOT NULL,
	`repo_id` text DEFAULT '' NOT NULL,
	`creator_id` integer NOT NULL,
	`is_closed` integer DEFAULT false NOT NULL,
	`board_type` integer DEFAULT 0 NOT NULL,
	`card_type` integer DEFAULT 0 NOT NULL,
	`type` integer NOT NULL,
	`closed_date_unix` integer,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_title_idx` ON `projects` (`title`);--> statement-breakpoint
CREATE INDEX `projects_owner_id_idx` ON `projects` (`owner_id`);--> statement-breakpoint
CREATE INDEX `projects_repo_id_idx` ON `projects` (`repo_id`);--> statement-breakpoint
CREATE INDEX `projects_is_closed_idx` ON `projects` (`is_closed`);
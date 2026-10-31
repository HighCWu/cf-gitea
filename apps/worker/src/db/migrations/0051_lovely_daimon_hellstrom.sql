CREATE TABLE `action_scoped_workflow_source` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer DEFAULT 0 NOT NULL,
	`source_repo_id` text NOT NULL,
	`workflow_configs` text DEFAULT '{}' NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_scoped_workflow_owner_repo_uq` ON `action_scoped_workflow_source` (`owner_id`,`source_repo_id`);--> statement-breakpoint
CREATE INDEX `action_scoped_workflow_source_repo_idx` ON `action_scoped_workflow_source` (`source_repo_id`);
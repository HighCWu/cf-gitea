CREATE TABLE `action_variables` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer DEFAULT 0 NOT NULL,
	`repo_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_variables_owner_repo_name_uq` ON `action_variables` (`owner_id`,`repo_id`,`name`);--> statement-breakpoint
CREATE INDEX `action_variables_owner_idx` ON `action_variables` (`owner_id`);--> statement-breakpoint
CREATE INDEX `action_variables_repo_id_idx` ON `action_variables` (`repo_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer DEFAULT 0 NOT NULL,
	`repo_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_owner_repo_name_uq` ON `secrets` (`owner_id`,`repo_id`,`name`);--> statement-breakpoint
CREATE INDEX `secrets_owner_idx` ON `secrets` (`owner_id`);--> statement-breakpoint
CREATE INDEX `secrets_repo_id_idx` ON `secrets` (`repo_id`);
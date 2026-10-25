CREATE TABLE `protected_branches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`rule_name` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`rules` text NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protected_branches_repo_rule_uq` ON `protected_branches` (`repo_id`,`rule_name`);--> statement-breakpoint
CREATE INDEX `protected_branches_repo_idx` ON `protected_branches` (`repo_id`);
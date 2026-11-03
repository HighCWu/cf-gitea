CREATE TABLE `renamed_branches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`from` text,
	`to` text,
	`created_unix` integer
);
--> statement-breakpoint
CREATE INDEX `renamed_branches_repo_idx` ON `renamed_branches` (`repo_id`);
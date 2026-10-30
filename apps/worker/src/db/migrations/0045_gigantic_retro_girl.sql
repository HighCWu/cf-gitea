CREATE TABLE `lfs_locks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`owner_id` integer NOT NULL,
	`path` text NOT NULL,
	`lower_path` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_lfs_locks_repo_lower_path` ON `lfs_locks` (`repo_id`,`lower_path`);
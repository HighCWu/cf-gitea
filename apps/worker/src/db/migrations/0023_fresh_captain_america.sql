CREATE TABLE `push_mirrors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`remote_name` text NOT NULL,
	`remote_address` text NOT NULL,
	`sync_on_commit` integer DEFAULT true NOT NULL,
	`interval_seconds` integer DEFAULT 0 NOT NULL,
	`created_unix` integer NOT NULL,
	`last_update_unix` integer,
	`last_error` text DEFAULT '' NOT NULL,
	`credentials_username` text,
	`credentials_ciphertext` text
);
--> statement-breakpoint
CREATE INDEX `push_mirrors_repo_id_idx` ON `push_mirrors` (`repo_id`);--> statement-breakpoint
CREATE INDEX `push_mirrors_last_update_idx` ON `push_mirrors` (`last_update_unix`);
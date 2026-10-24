CREATE TABLE `repo_mirrors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`interval_seconds` integer DEFAULT 28800 NOT NULL,
	`enable_prune` integer DEFAULT true NOT NULL,
	`lfs_enabled` integer DEFAULT false NOT NULL,
	`lfs_endpoint` text,
	`remote_address` text NOT NULL,
	`credentials_username` text,
	`credentials_ciphertext` text,
	`sync_state` text DEFAULT 'idle' NOT NULL,
	`next_sync_at` integer DEFAULT 0 NOT NULL,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "repo_mirrors_sync_state_check" CHECK("repo_mirrors"."sync_state" IN ('idle', 'queued', 'syncing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_mirrors_repo_id_unique` ON `repo_mirrors` (`repo_id`);--> statement-breakpoint
ALTER TABLE `repositories` ADD `is_mirror` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `original_url` text;
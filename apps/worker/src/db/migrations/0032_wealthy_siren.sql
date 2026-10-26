PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_push_mirrors` (
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
	`credentials_ciphertext` text,
	`sync_state` text DEFAULT 'idle' NOT NULL,
	`next_sync_at` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_mirrors_sync_state_check" CHECK("__new_push_mirrors"."sync_state" IN ('idle', 'queued', 'syncing'))
);
--> statement-breakpoint
INSERT INTO `__new_push_mirrors`("id", "repo_id", "remote_name", "remote_address", "sync_on_commit", "interval_seconds", "created_unix", "last_update_unix", "last_error", "credentials_username", "credentials_ciphertext", "sync_state", "next_sync_at") SELECT "id", "repo_id", "remote_name", "remote_address", "sync_on_commit", "interval_seconds", "created_unix", "last_update_unix", "last_error", "credentials_username", "credentials_ciphertext", "sync_state", "next_sync_at" FROM `push_mirrors`;--> statement-breakpoint
DROP TABLE `push_mirrors`;--> statement-breakpoint
ALTER TABLE `__new_push_mirrors` RENAME TO `push_mirrors`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `push_mirrors_repo_id_idx` ON `push_mirrors` (`repo_id`);--> statement-breakpoint
CREATE INDEX `push_mirrors_last_update_idx` ON `push_mirrors` (`last_update_unix`);--> statement-breakpoint
CREATE INDEX `push_mirrors_next_sync_idx` ON `push_mirrors` (`next_sync_at`);
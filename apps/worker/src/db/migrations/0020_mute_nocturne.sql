CREATE TABLE `deploy_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_id` integer DEFAULT 0 NOT NULL,
	`repo_id` text NOT NULL,
	`name` text NOT NULL,
	`key_type` integer DEFAULT 1 NOT NULL,
	`fingerprint` text NOT NULL,
	`token_hash` text DEFAULT '' NOT NULL,
	`mode` integer DEFAULT 1 NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deploy_keys_key_id_idx` ON `deploy_keys` (`key_id`);--> statement-breakpoint
CREATE INDEX `deploy_keys_repo_id_idx` ON `deploy_keys` (`repo_id`);--> statement-breakpoint
CREATE INDEX `deploy_keys_token_hash_idx` ON `deploy_keys` (`token_hash`);--> statement-breakpoint
-- Deploy-key system principal (data, not schema — drizzle snapshots cannot
-- express seed rows, so this statement is appended to the generated
-- migration, the migration-0003 'assets' precedent): upstream materializes
-- deploy public-key rows with owner_id = 0 (no owner), which the landed
-- `public_keys.owner_id → users.id` FK cannot store. The service layer
-- (services/deploy-keys.ts) points them at the upstream system principal
-- `gitea:deploy-key` instead (user_system.go:76, DeployKeyUserID = -3) —
-- seeded here as the backstop and re-asserted on demand (INSERT OR IGNORE)
-- so freshly-migrated and wiped-test databases both satisfy the FK.
-- `users.username_lower` is UNIQUE, so the name is un-takeable at the DB
-- level; status 'prohibited' renders prohibit_login=true if it ever leaks
-- into a listing (the same accepted tradeoff as the 'assets' row).
INSERT INTO `users` (`id`, `username`, `username_lower`, `is_admin`, `status`, `created_at`)
VALUES (-3, 'gitea:deploy-key', 'gitea:deploy-key', 0, 'prohibited', unixepoch());
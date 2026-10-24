CREATE TABLE `repo_redirects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`owner_namespace` text NOT NULL,
	`lower_name` text NOT NULL,
	`redirect_repo_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_redirects_owner_name_uq` ON `repo_redirects` (`owner_id`,`lower_name`);--> statement-breakpoint
CREATE INDEX `repo_redirects_lookup_idx` ON `repo_redirects` (`owner_namespace`,`lower_name`);--> statement-breakpoint
CREATE INDEX `repo_redirects_repo_idx` ON `repo_redirects` (`redirect_repo_id`);--> statement-breakpoint
CREATE TABLE `repo_transfer` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`doer_id` integer NOT NULL,
	`new_owner_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_transfer_repo_id_unique` ON `repo_transfer` (`repo_id`);--> statement-breakpoint
CREATE TABLE `repo_units` (
	`repo_id` text NOT NULL,
	`type` text DEFAULT 'code' NOT NULL,
	`anonymous_access_mode` text DEFAULT 'none' NOT NULL,
	PRIMARY KEY(`repo_id`, `type`)
);
--> statement-breakpoint
ALTER TABLE `repositories` ADD `owner_id` integer;--> statement-breakpoint
ALTER TABLE `repositories` ADD `default_branch` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `is_empty` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `is_archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
-- SPEC-0008 reservation (data, not schema — drizzle snapshots cannot express
-- seed rows, so this statement is appended to the generated migration):
-- `users.username_lower` is UNIQUE, and the seeded, permanently 'prohibited'
-- 'assets' row makes the name un-takeable at the DB level (any future
-- INSERT of username_lower='assets' violates users_username_lower_uq).
-- The service-level reserved-names check (isReservedOwnerName, src/repos) is
-- the upstream-style create-path guard; this row is the hard backstop.
INSERT INTO `users` (`username`, `username_lower`, `is_admin`, `status`, `created_at`)
VALUES ('assets', 'assets', 0, 'prohibited', unixepoch());
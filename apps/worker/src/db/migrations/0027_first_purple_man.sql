CREATE TABLE `badge` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`image_url` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `badge_slug_unique` ON `badge` (`slug`);--> statement-breakpoint
CREATE TABLE `repo_license` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`commit_id` text,
	`license` text NOT NULL,
	`license_path` text DEFAULT 'LICENSE' NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_license_path_uq` ON `repo_license` (`repo_id`,`license`,`license_path`);--> statement-breakpoint
CREATE INDEX `repo_license_created_idx` ON `repo_license` (`created_unix`);--> statement-breakpoint
CREATE INDEX `repo_license_updated_idx` ON `repo_license` (`updated_unix`);--> statement-breakpoint
CREATE TABLE `user_badge` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`badge_id` integer NOT NULL,
	`user_id` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_user_badge` ON `user_badge` (`user_id`,`badge_id`);--> statement-breakpoint
ALTER TABLE `repositories` ADD `is_template` integer DEFAULT false NOT NULL;
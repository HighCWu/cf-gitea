CREATE TABLE `lfs_objects` (
	`repo_id` integer NOT NULL,
	`oid` text NOT NULL,
	`size` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `oid`)
);
--> statement-breakpoint
CREATE INDEX `idx_lfs_objects_repo_state_updated` ON `lfs_objects` (`repo_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `org_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_members_org_user_uq` ON `org_members` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `org_members_user_idx` ON `org_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_redirects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lower_name` text NOT NULL,
	`redirect_user_id` integer NOT NULL,
	FOREIGN KEY (`redirect_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_redirects_lower_uq` ON `user_redirects` (`lower_name`);--> statement-breakpoint
ALTER TABLE `users` ADD `type` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `full_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD `description` text;--> statement-breakpoint
ALTER TABLE `users` ADD `website` text;--> statement-breakpoint
ALTER TABLE `users` ADD `location` text;--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_email` text;--> statement-breakpoint
ALTER TABLE `users` ADD `use_custom_avatar` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `num_members` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `repo_admin_change_team_access` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `users_type_idx` ON `users` (`type`);
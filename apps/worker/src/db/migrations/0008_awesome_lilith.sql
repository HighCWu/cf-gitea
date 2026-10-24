CREATE TABLE `stars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`repo_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stars_user_repo_uq` ON `stars` (`user_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX `stars_repo_idx` ON `stars` (`repo_id`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'gitea-auto' NOT NULL,
	`language` text DEFAULT '' NOT NULL,
	`diff_view_style` text DEFAULT '' NOT NULL,
	`hide_email` integer DEFAULT false NOT NULL,
	`hide_activity` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

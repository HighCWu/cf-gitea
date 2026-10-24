CREATE TABLE `follows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`follow_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`follow_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follows_user_follow_uq` ON `follows` (`user_id`,`follow_id`);--> statement-breakpoint
CREATE INDEX `follows_follow_idx` ON `follows` (`follow_id`);--> statement-breakpoint
CREATE TABLE `repo_collaborators` (
	`repo_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`mode` text DEFAULT 'write' NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	PRIMARY KEY(`repo_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_repo_collaborators_user` ON `repo_collaborators` (`user_id`);--> statement-breakpoint
CREATE TABLE `repo_settings` (
	`repo_id` text PRIMARY KEY NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`has_issues` integer DEFAULT true NOT NULL,
	`has_wiki` integer DEFAULT true NOT NULL,
	`has_pull_requests` integer DEFAULT true NOT NULL,
	`has_releases` integer DEFAULT true NOT NULL,
	`has_projects` integer DEFAULT false NOT NULL,
	`has_packages` integer DEFAULT false NOT NULL,
	`has_actions` integer DEFAULT false NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `repo_topics` (
	`repo_id` text NOT NULL,
	`topic` text NOT NULL,
	PRIMARY KEY(`repo_id`, `topic`)
);
--> statement-breakpoint
CREATE TABLE `repo_watchers` (
	`repo_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`repo_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_repo_watchers_user` ON `repo_watchers` (`user_id`);
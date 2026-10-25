CREATE TABLE `team_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`team_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_team_user_uq` ON `team_members` (`team_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `team_members_org_user_idx` ON `team_members` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `team_members_user_idx` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `team_repo_access` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`team_id` integer NOT NULL,
	`repo_id` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_repo_access_team_repo_uq` ON `team_repo_access` (`team_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX `team_repo_access_repo_idx` ON `team_repo_access` (`repo_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` integer NOT NULL,
	`lower_name` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`authorize` text DEFAULT 'none' NOT NULL,
	`includes_all_repositories` integer DEFAULT false NOT NULL,
	`can_create_org_repo` integer DEFAULT false NOT NULL,
	`num_repos` integer DEFAULT 0 NOT NULL,
	`num_members` integer DEFAULT 0 NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`units_map` text,
	FOREIGN KEY (`org_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_org_lower_uq` ON `teams` (`org_id`,`lower_name`);--> statement-breakpoint
CREATE INDEX `teams_org_idx` ON `teams` (`org_id`);
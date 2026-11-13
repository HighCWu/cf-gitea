CREATE TABLE `team_invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`inviter_id` integer NOT NULL,
	`org_id` integer NOT NULL,
	`team_id` integer NOT NULL,
	`email` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_invites_token_uq` ON `team_invites` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_invites_team_email_uq` ON `team_invites` (`team_id`,`email`);
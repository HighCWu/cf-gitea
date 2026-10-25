CREATE TABLE `pull_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` integer NOT NULL,
	`reviewer_id` integer DEFAULT 0 NOT NULL,
	`reviewer_team_id` integer DEFAULT 0 NOT NULL,
	`issue_id` integer NOT NULL,
	`content` text,
	`official` integer DEFAULT false NOT NULL,
	`commit_id` text,
	`stale` integer DEFAULT false NOT NULL,
	`dismissed` integer DEFAULT false NOT NULL,
	`created_unix` integer,
	`updated_unix` integer
);
--> statement-breakpoint
CREATE INDEX `pull_reviews_issue_idx` ON `pull_reviews` (`issue_id`);--> statement-breakpoint
CREATE INDEX `pull_reviews_reviewer_idx` ON `pull_reviews` (`issue_id`,`reviewer_id`,`type`);
CREATE TABLE `issue_content_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poster_id` integer,
	`issue_id` integer NOT NULL,
	`comment_id` integer DEFAULT 0 NOT NULL,
	`edited_unix` integer NOT NULL,
	`content_text` text NOT NULL,
	`is_first_created` integer DEFAULT false NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issue_content_history_issue_idx` ON `issue_content_history` (`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_content_history_comment_idx` ON `issue_content_history` (`comment_id`);--> statement-breakpoint
CREATE INDEX `issue_content_history_edited_idx` ON `issue_content_history` (`edited_unix`);
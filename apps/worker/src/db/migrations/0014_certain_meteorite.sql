CREATE TABLE `issue_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uuid` text NOT NULL,
	`issue_id` integer NOT NULL,
	`comment_id` integer DEFAULT 0 NOT NULL,
	`uploader_id` integer,
	`name` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`r2_key` text,
	`checksum_sha256` text,
	`created_unix` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_attachments_uuid_uq` ON `issue_attachments` (`uuid`);--> statement-breakpoint
CREATE INDEX `issue_attachments_issue_idx` ON `issue_attachments` (`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_attachments_comment_idx` ON `issue_attachments` (`comment_id`);
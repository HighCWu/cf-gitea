CREATE TABLE `email_inbound` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedupe_key` text NOT NULL,
	`message_id` text DEFAULT '' NOT NULL,
	`from_address` text NOT NULL,
	`to_addr` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`auth_results` text,
	`token_status` text DEFAULT 'none' NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`user_id` integer,
	`ref_type` text,
	`ref_id` integer,
	`comment_id` integer,
	`error` text,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_inbound_dedupe_key_uq` ON `email_inbound` (`dedupe_key`);
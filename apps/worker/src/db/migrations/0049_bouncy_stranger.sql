CREATE TABLE `email_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`info` text NOT NULL,
	`from_address` text NOT NULL,
	`from_display_name` text DEFAULT '' NOT NULL,
	`to_addr` text NOT NULL,
	`reply_to` text,
	`subject` text NOT NULL,
	`body_html` text NOT NULL,
	`headers` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_outbox_dedupe_key_uq` ON `email_outbox` (`dedupe_key`);
CREATE TABLE `user_blocking` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`blocker_id` integer NOT NULL,
	`blockee_id` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blockee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_blocking_block_uq` ON `user_blocking` (`blocker_id`,`blockee_id`);--> statement-breakpoint
CREATE INDEX `user_blocking_blockee_idx` ON `user_blocking` (`blockee_id`);--> statement-breakpoint
CREATE INDEX `user_blocking_created_idx` ON `user_blocking` (`created_at`);
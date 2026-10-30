CREATE TABLE `user_settings_kv` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`setting_key` text NOT NULL,
	`setting_value` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_settings_kv_user_key_uq` ON `user_settings_kv` (`user_id`,`setting_key`);
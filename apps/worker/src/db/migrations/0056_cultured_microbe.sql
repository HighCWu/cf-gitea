CREATE TABLE `external_login_user` (
	`external_id` text NOT NULL,
	`login_source_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`email` text,
	`name` text,
	`nick_name` text,
	`avatar_url` text,
	`location` text,
	`description` text,
	`first_name` text,
	`last_name` text,
	`access_token` text,
	`access_token_secret` text,
	`refresh_token` text,
	`expires_at` integer,
	PRIMARY KEY(`external_id`, `login_source_id`),
	FOREIGN KEY (`login_source_id`) REFERENCES `login_source`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_login_user_user_id_idx` ON `external_login_user` (`user_id`);--> statement-breakpoint
CREATE INDEX `external_login_user_provider_idx` ON `external_login_user` (`provider`);--> statement-breakpoint
CREATE TABLE `login_source` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` integer NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`is_sync_enabled` integer DEFAULT false NOT NULL,
	`two_factor_policy` text DEFAULT '' NOT NULL,
	`cfg` text NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_source_name_uq` ON `login_source` (`name`);--> statement-breakpoint
CREATE INDEX `login_source_is_active_idx` ON `login_source` (`is_active`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `oauth2_login_state` text;
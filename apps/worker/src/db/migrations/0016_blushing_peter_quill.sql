CREATE TABLE `email_addresses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`email` text NOT NULL,
	`lower_email` text NOT NULL,
	`is_activated` integer DEFAULT false NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_addresses_email_uq` ON `email_addresses` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_addresses_lower_email_uq` ON `email_addresses` (`lower_email`);--> statement-breakpoint
CREATE INDEX `email_addresses_user_idx` ON `email_addresses` (`user_id`);--> statement-breakpoint
CREATE TABLE `gpg_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`key_id` text(16) NOT NULL,
	`primary_key_id` text(16) DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`can_sign` integer DEFAULT false NOT NULL,
	`can_encrypt_comms` integer DEFAULT false NOT NULL,
	`can_encrypt_storage` integer DEFAULT false NOT NULL,
	`can_certify` integer DEFAULT false NOT NULL,
	`created_unix` integer NOT NULL,
	`expired_unix` integer,
	`added_unix` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gpg_keys_owner_idx` ON `gpg_keys` (`owner_id`);--> statement-breakpoint
CREATE INDEX `gpg_keys_key_id_idx` ON `gpg_keys` (`key_id`);--> statement-breakpoint
CREATE INDEX `gpg_keys_primary_key_id_idx` ON `gpg_keys` (`primary_key_id`);--> statement-breakpoint
CREATE TABLE `public_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`name` text NOT NULL,
	`fingerprint` text NOT NULL,
	`content` text NOT NULL,
	`mode` integer DEFAULT 2 NOT NULL,
	`type` integer DEFAULT 1 NOT NULL,
	`login_source_id` integer DEFAULT 0 NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `public_keys_owner_idx` ON `public_keys` (`owner_id`);--> statement-breakpoint
CREATE INDEX `public_keys_fingerprint_idx` ON `public_keys` (`fingerprint`);
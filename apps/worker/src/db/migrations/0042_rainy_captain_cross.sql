CREATE TABLE `system_keystore` (
	`name` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);

CREATE TABLE `email_hash` (
	`hash` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`hash_type` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_hash_email_hash_type_uq` ON `email_hash` (`email`,`hash_type`);
CREATE TABLE `system_notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` integer NOT NULL,
	`description` text NOT NULL,
	`created_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `system_notices_created_idx` ON `system_notices` (`created_unix`);
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_key` text NOT NULL,
	`owner_namespace` text NOT NULL,
	`slug` text NOT NULL,
	`visibility` text NOT NULL,
	`refs_version` integer DEFAULT 0 NOT NULL,
	`backend` text DEFAULT 'self-hosted' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_storage_key_unique` ON `repositories` (`storage_key`);
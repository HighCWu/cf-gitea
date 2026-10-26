CREATE TABLE `oauth2_application` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uid` integer NOT NULL,
	`name` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`confidential_client` integer DEFAULT true NOT NULL,
	`skip_secondary_authorization` integer DEFAULT false NOT NULL,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth2_application_client_id_unique` ON `oauth2_application` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth2_application_uid_idx` ON `oauth2_application` (`uid`);
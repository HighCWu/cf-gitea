CREATE TABLE `package_blob_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`bytes_received` integer DEFAULT 0 NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `package_blob_uploads_updated_idx` ON `package_blob_uploads` (`updated_unix`);
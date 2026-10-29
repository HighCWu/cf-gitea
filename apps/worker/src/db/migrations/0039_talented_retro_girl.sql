CREATE TABLE `package_blobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`hash_md5` text,
	`hash_sha1` text,
	`hash_sha256` text NOT NULL,
	`hash_sha512` text,
	`created_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_blobs_md5_uq` ON `package_blobs` (`hash_md5`);--> statement-breakpoint
CREATE UNIQUE INDEX `package_blobs_sha1_uq` ON `package_blobs` (`hash_sha1`);--> statement-breakpoint
CREATE UNIQUE INDEX `package_blobs_sha256_uq` ON `package_blobs` (`hash_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `package_blobs_sha512_uq` ON `package_blobs` (`hash_sha512`);--> statement-breakpoint
CREATE INDEX `package_blobs_created_idx` ON `package_blobs` (`created_unix`);--> statement-breakpoint
CREATE TABLE `package_cleanup_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`owner_id` integer DEFAULT 0 NOT NULL,
	`type` text NOT NULL,
	`keep_count` integer DEFAULT 0 NOT NULL,
	`keep_pattern` text DEFAULT '' NOT NULL,
	`remove_days` integer DEFAULT 0 NOT NULL,
	`remove_pattern` text DEFAULT '' NOT NULL,
	`match_full_name` integer DEFAULT false NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_cleanup_rules_owner_type_uq` ON `package_cleanup_rules` (`owner_id`,`type`);--> statement-breakpoint
CREATE TABLE `package_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` integer NOT NULL,
	`blob_id` integer NOT NULL,
	`name` text NOT NULL,
	`lower_name` text NOT NULL,
	`composite_key` text DEFAULT '' NOT NULL,
	`is_lead` integer DEFAULT false NOT NULL,
	`created_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_files_version_lower_composite_uq` ON `package_files` (`version_id`,`lower_name`,`composite_key`);--> statement-breakpoint
CREATE INDEX `package_files_blob_idx` ON `package_files` (`blob_id`);--> statement-breakpoint
CREATE TABLE `package_properties` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ref_type` integer NOT NULL,
	`ref_id` integer NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `package_properties_ref_idx` ON `package_properties` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `package_properties_name_idx` ON `package_properties` (`name`);--> statement-breakpoint
CREATE TABLE `package_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`package_id` integer NOT NULL,
	`creator_id` integer DEFAULT 0 NOT NULL,
	`version` text NOT NULL,
	`lower_version` text NOT NULL,
	`created_unix` integer NOT NULL,
	`is_internal` integer DEFAULT false NOT NULL,
	`metadata_json` text,
	`download_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_versions_package_lower_version_uq` ON `package_versions` (`package_id`,`lower_version`);--> statement-breakpoint
CREATE INDEX `package_versions_created_idx` ON `package_versions` (`created_unix`);--> statement-breakpoint
CREATE TABLE `packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`repo_id` text,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`lower_name` text NOT NULL,
	`semver_compatible` integer DEFAULT false NOT NULL,
	`is_internal` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packages_owner_type_lower_name_uq` ON `packages` (`owner_id`,`type`,`lower_name`);--> statement-breakpoint
CREATE INDEX `packages_repo_id_idx` ON `packages` (`repo_id`);
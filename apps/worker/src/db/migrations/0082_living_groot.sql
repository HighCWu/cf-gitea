DROP INDEX `package_properties_ref_idx`;--> statement-breakpoint
DROP INDEX `package_properties_name_idx`;--> statement-breakpoint
CREATE INDEX `package_properties_ref_id_name_idx` ON `package_properties` (`ref_id`,`name`);
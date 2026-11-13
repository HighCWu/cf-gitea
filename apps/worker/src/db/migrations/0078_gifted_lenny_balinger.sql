PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issue_labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`label_id` integer NOT NULL
);
--> statement-breakpoint
-- ADR-0007 FN-10: the rebuild's copy. The generated statement selected the
-- NEW `id` column from the OLD table by double-quoted name — it doesn't
-- exist there, and SQLite's double-quoted-string misfeature materializes
-- the literal string 'id' for every row, which the rowid alias rejects
-- (`datatype mismatch`; an empty table copies zero rows and hides the
-- trap — the fresh-chain applies never hit it). Corrected per the 0066/
-- 0077 precedent: the copy references only the columns the pre-0078 table
-- actually has (`issue_id`, `label_id`); `id` is omitted from both legs so
-- SQLite assigns fresh autoincrement values (insertion order preserved —
-- the attach order the label strips render).
INSERT INTO `__new_issue_labels`("issue_id", "label_id") SELECT "issue_id", "label_id" FROM `issue_labels`;--> statement-breakpoint
DROP TABLE `issue_labels`;--> statement-breakpoint
ALTER TABLE `__new_issue_labels` RENAME TO `issue_labels`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_labels_issue_label_uq` ON `issue_labels` (`issue_id`,`label_id`);--> statement-breakpoint
CREATE INDEX `issue_labels_label_idx` ON `issue_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `__new_issue_pins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`issue_id` integer NOT NULL,
	`is_pull` integer NOT NULL,
	`pin_order` integer NOT NULL
);
--> statement-breakpoint
-- ADR-0007 FN-10: the rebuild's copy, double-corrected. Beyond the
-- double-quoted `"id"` trap documented above (the old table has no id —
-- omitted from both legs, fresh autoincrement values), the generated
-- statement also selected `"is_pull"` from the OLD table, which has no
-- such column: the literal string 'is_pull' would land in every row and
-- satisfy NOT NULL with garbage. is_pull is NOT NULL with NO DDL default
-- (the value-drift rule), so the copy must supply the true value: the pin
-- row's discriminator is its issue's `issues.is_pull`, joined by the pin's
-- issue_id (every pin row references an existing issue — the single writer
-- copies from issues). COALESCE guards a dangling edge at 0 rather than
-- aborting the migration.
INSERT INTO `__new_issue_pins`("repo_id", "issue_id", "is_pull", "pin_order") SELECT ip."repo_id", ip."issue_id", COALESCE(i."is_pull", 0), ip."pin_order" FROM `issue_pins` AS ip LEFT JOIN `issues` AS i ON i."id" = ip."issue_id";--> statement-breakpoint
DROP TABLE `issue_pins`;--> statement-breakpoint
ALTER TABLE `__new_issue_pins` RENAME TO `issue_pins`;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_pins_issue_id_uq` ON `issue_pins` (`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_pins_repo_order_idx` ON `issue_pins` (`repo_id`,`pin_order`);--> statement-breakpoint
ALTER TABLE `package_blob_uploads` ADD `hash_state_bytes` blob;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `type` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `changed_protected_files` text;
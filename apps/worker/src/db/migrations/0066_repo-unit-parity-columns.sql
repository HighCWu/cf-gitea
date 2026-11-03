PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repo_units` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`type` text DEFAULT 'code' NOT NULL,
	`config` text,
	`created_unix` integer,
	`anonymous_access_mode` text DEFAULT 'none' NOT NULL,
	`everyone_access_mode` text DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
-- ADR-0007 FN-6: the rebuild's copy. The generated statement selected the
-- NEW columns (`id`, `created_unix`, `everyone_access_mode`) from the OLD
-- table by double-quoted name — they don't exist there, and SQLite's
-- double-quoted-string misfeature silently turned them into the literal
-- strings 'created_unix'/'everyone_access_mode' (observed on the local
-- apply: typeof(created_unix) = text). Corrected: the copy references only
-- the columns the pre-0066 table actually has; `id` is omitted so SQLite
-- assigns fresh autoincrement values, `created_unix` is omitted (NULL —
-- the backfill below stamps it), and `everyone_access_mode` is omitted
-- (its NOT NULL DEFAULT 'none' — upstream DEFAULT 0 — fills).
INSERT INTO `__new_repo_units`("repo_id", "type", "config", "anonymous_access_mode") SELECT "repo_id", "type", "config", "anonymous_access_mode" FROM `repo_units`;--> statement-breakpoint
DROP TABLE `repo_units`;--> statement-breakpoint
ALTER TABLE `__new_repo_units` RENAME TO `repo_units`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `repo_units_repo_type_uq` ON `repo_units` (`repo_id`,`type`);--> statement-breakpoint
-- ADR-0007 FN-6 backfill: upstream's `CreatedUnix` (repo_unit.go:47,
-- xorm `INDEX CREATED`) is stamped at insert and never NULL; the pre-0066
-- rows predate the column. A unit row never predates its repo, so the
-- parent repositories.created_at is the best recoverable creation time
-- (toggle-created rows get the repo's creation instant — an approximation,
-- recorded in SPEC-0003 §3.1 as-built; the column has no reader yet).
UPDATE `repo_units`
SET `created_unix` = (SELECT `r`.`created_at` FROM `repositories` `r` WHERE `r`.`id` = `repo_units`.`repo_id`)
WHERE `created_unix` IS NULL;
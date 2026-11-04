-- ADR-0007 FN-10/FN-12: the two ours-looser NOT-NULL strictness flips the
-- FN-13 disposition left DRIFT (audit §7.1 verified-members table):
--   1. `issue_pins.repo_id` — upstream `RepoID int64 UNIQUE(s) NOT NULL`
--      (models/issues/issue_pin.go:19) vs ours NULLable TEXT. The
--      "composite PK" option is DEAD per the audit §7.1 shape erratum
--      (2026-11-04): ours' PK is the single-column issue_id
--      (schema.ts:1286) and repo_id's NULLability is the real inversion —
--      this migration settles it with NOT NULL, PK untouched.
--   2. `issue_subscriptions.created_unix` / `.updated_unix` — upstream
--      `created NOT NULL` / `updated NOT NULL` (models/issues/
--      issue_watch.go:22-23) vs ours NULLable.
-- SQLite cannot ALTER a column's nullability, so both tables REBUILD
-- (create-copy-drop-rename). NULL-path derivation: each table has exactly
-- ONE landed writer — insertIssuePin (api/services/issue-extras.ts) copies
-- `issues.repo_id` (itself NOT NULL) and setIssueSubscription stamps
-- created_unix + updated_unix on the insert arm and re-stamps updated_unix
-- on the conflict arm — so no NULL can ride either column through any
-- landed path; the backfills below are defensive only (a legacy-NULL row
-- would otherwise hard-fail the rebuild's INSERT…SELECT with an opaque
-- NOT NULL constraint error). The `issue_pins` backfill resolves from the
-- parent `issues.repo_id`; an unresolvable row (issue gone — impossible
-- through landed writers, the repo delete cascade detaches pins by
-- repo_id) would fail loudly rather than silently drop. The 0066 DQS
-- audit applied: every identifier backtick-quoted, zero double-quoted
-- tokens, no string literals at all — nothing for DQS to reinterpret.
-- Hand-authored per the 0064/0069 --custom precedent; the 0073 snapshot is
-- hand-moved to the post-flip state (0069's recorded procedure).
-- Defensive backfill: resolve legacy-NULL pin repo_ids from the parent.
UPDATE `issue_pins` SET `repo_id` = (
	SELECT `i`.`repo_id` FROM `issues` `i` WHERE `i`.`id` = `issue_pins`.`issue_id`
) WHERE `repo_id` IS NULL;--> statement-breakpoint
-- Defensive backfills: legacy-NULL subscription timestamps — created
-- borrows updated (the xorm-updated arm always ran) falling to now;
-- updated borrows the now-complete created.
UPDATE `issue_subscriptions` SET `created_unix` = COALESCE(`created_unix`, `updated_unix`, unixepoch()) WHERE `created_unix` IS NULL;--> statement-breakpoint
UPDATE `issue_subscriptions` SET `updated_unix` = COALESCE(`updated_unix`, `created_unix`) WHERE `updated_unix` IS NULL;--> statement-breakpoint
-- Rebuild 1/2: issue_pins (FK-free; indexes re-created after the swap).
CREATE TABLE `issue_pins_new` (
	`issue_id` integer PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`pin_order` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `issue_pins_new` (`issue_id`, `repo_id`, `pin_order`) SELECT `issue_id`, `repo_id`, `pin_order` FROM `issue_pins`;--> statement-breakpoint
DROP TABLE `issue_pins`;--> statement-breakpoint
ALTER TABLE `issue_pins_new` RENAME TO `issue_pins`;--> statement-breakpoint
CREATE INDEX `issue_pins_repo_order_idx` ON `issue_pins` (`repo_id`,`pin_order`);--> statement-breakpoint
-- Rebuild 2/2: issue_subscriptions.
CREATE TABLE `issue_subscriptions_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`is_watching` integer NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `issue_subscriptions_new` (`id`, `user_id`, `issue_id`, `is_watching`, `created_unix`, `updated_unix`) SELECT `id`, `user_id`, `issue_id`, `is_watching`, `created_unix`, `updated_unix` FROM `issue_subscriptions`;--> statement-breakpoint
DROP TABLE `issue_subscriptions`;--> statement-breakpoint
ALTER TABLE `issue_subscriptions_new` RENAME TO `issue_subscriptions`;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_subscriptions_user_issue_uq` ON `issue_subscriptions` (`user_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_subscriptions_issue_idx` ON `issue_subscriptions` (`issue_id`);

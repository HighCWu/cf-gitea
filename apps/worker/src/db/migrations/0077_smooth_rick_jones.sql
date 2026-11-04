PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repo_collaborators` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`mode` text DEFAULT 'write' NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
-- ADR-0007 FN-12: the rebuild's copy. The generated statement selected the
-- NEW `id` column from the OLD table by double-quoted name — it doesn't
-- exist there, and SQLite's double-quoted-string misfeature materializes
-- the literal string 'id' for every row, which the rowid alias rejects
-- (`datatype mismatch`; an empty table copies zero rows and hides the
-- trap — the fresh-chain applies never hit it). Corrected per the 0066
-- precedent: the copy references only the columns the pre-0077 table
-- actually has; `id` is omitted from both legs so SQLite assigns fresh
-- autoincrement values (insertion order preserved — the id order the
-- list/assignee renders read).
INSERT INTO `__new_repo_collaborators`("repo_id", "user_id", "mode", "created_at", "updated_at") SELECT "repo_id", "user_id", "mode", "created_at", "updated_at" FROM `repo_collaborators`;--> statement-breakpoint
DROP TABLE `repo_collaborators`;--> statement-breakpoint
ALTER TABLE `__new_repo_collaborators` RENAME TO `repo_collaborators`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `repo_collaborators_repo_user_uq` ON `repo_collaborators` (`repo_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_repo_collaborators_user` ON `repo_collaborators` (`user_id`);--> statement-breakpoint
ALTER TABLE `gpg_keys` ADD `emails` text;--> statement-breakpoint
ALTER TABLE `issue_dependency` ADD `updated_unix` integer;--> statement-breakpoint
ALTER TABLE `repo_transfer` ADD `recipient_access_granted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repo_transfer` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `repo_transfer_updated_at_idx` ON `repo_transfer` (`updated_at`);
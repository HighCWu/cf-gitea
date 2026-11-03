-- ADR-0007 FN-8: the commit_statuses.context_hash + `index` completion
-- (SPEC-0005 §10 as-built; derivation record: audit §7.12). Upstream pin
-- fc49368845: CommitStatus.Index int64 `INDEX UNIQUE(repo_sha_index)`
-- (models/git/commit_status.go:41) + ContextHash VARCHAR(64) index (:50),
-- plus the CommitStatusIndex counter table (:329-335) — table name
-- pluralized per the §7.5 family (upstream singular `commit_status_index`,
-- the pattern that made `commit_status` → `commit_statuses`). Both columns
-- NULLABLE per the upstream tags (neither carries NOT NULL — contrast :40
-- SHA). `index` is a SQLite RESERVED WORD: backtick-quoted on every raw
-- surface here, exactly like upstream (:315-325, :346, :357). Hand-authored
-- per the 0064/0069 --custom precedent; the 0072 snapshot is hand-moved to
-- the post-add state (0069's recorded procedure).
ALTER TABLE `commit_statuses` ADD `context_hash` text;--> statement-breakpoint
ALTER TABLE `commit_statuses` ADD `index` integer;--> statement-breakpoint
CREATE TABLE `commit_status_indexes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`sha` text NOT NULL,
	`max_index` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commit_status_indexes_repo_sha_uq` ON `commit_status_indexes` (`repo_id`,`sha`);--> statement-breakpoint
CREATE INDEX `commit_status_indexes_max_index_idx` ON `commit_status_indexes` (`max_index`);--> statement-breakpoint
-- Backfill `index` (upstream's v88 context_hash backfill precedent ships the
-- same data-repair-in-migration posture): the per-(repo, sha) 1-based
-- creation ordinal reconstructed from insertion order — correlated-count
-- form, order-equivalent to ROW_NUMBER() OVER (PARTITION BY repo_id, sha
-- ORDER BY id ASC). Within one (repo, sha) creation order ascends with the
-- global autoincrement id (the order oracle the module comment recorded);
-- created_unix cannot do this (1-second resolution is upstream's own reason
-- for the column, commit_status.go:325). context_hash has NO SQL backfill —
-- D1's SQLite core has no sha1() and the value MUST be sha1-hex (the writers
-- compute exactly that); pre-port rows repair lazily on the read path
-- (SPEC-0005 §10.3.5) and NULL-hash rows group by raw context meanwhile
-- (SQL's single NULL group = today's observable, degradation-safe).
UPDATE `commit_statuses` SET `index` = (
	SELECT COUNT(*) FROM `commit_statuses` c2
	WHERE c2.`repo_id` = `commit_statuses`.`repo_id`
	  AND c2.`sha` = `commit_statuses`.`sha`
	  AND c2.`id` <= `commit_statuses`.`id`
);--> statement-breakpoint
-- Seed the counter so it RESUMES instead of restarting — upstream's own
-- v195 seed shape (modelmigration/v1_16/v195.go:39-44).
INSERT INTO `commit_status_indexes` (`repo_id`, `sha`, `max_index`)
SELECT `repo_id`, `sha`, max(`index`) FROM `commit_statuses` GROUP BY `repo_id`, `sha`;--> statement-breakpoint
-- Enforcement in INDEX form (D1 ADD COLUMN cannot add table constraints; a
-- UNIQUE table constraint over existing+new columns would force a SQLite
-- table rebuild — the FN-6/0066 lesson). NULLs are distinct in unique
-- indexes, so un-backfilled rows never violate.
CREATE UNIQUE INDEX `commit_statuses_repo_sha_index_uq` ON `commit_statuses` (`repo_id`,`sha`,`index`);--> statement-breakpoint
CREATE INDEX `commit_statuses_index_idx` ON `commit_statuses` (`index`);--> statement-breakpoint
CREATE INDEX `commit_statuses_ctx_hash_idx` ON `commit_statuses` (`context_hash`);
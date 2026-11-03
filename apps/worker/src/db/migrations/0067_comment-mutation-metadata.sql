-- ADR-0007 FN-2: the comments mutation-metadata columns (SPEC-0005 §7
-- as-built; upstream models/issues/comment.go). Pure ADD COLUMN — no table
-- rebuild, so 0066's double-quoted-copy trap does not apply. Five columns
-- land; the original_author pair is intentional-recorded-absent (SPEC-0005
-- §9 — the forge-metadata importer's mark, no importer surface here).
ALTER TABLE `comments` ADD `old_project_id` integer;--> statement-breakpoint
ALTER TABLE `comments` ADD `project_id` integer;--> statement-breakpoint
ALTER TABLE `comments` ADD `time_id` integer;--> statement-breakpoint
ALTER TABLE `comments` ADD `assignee_team_id` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD `comment_meta_data` text;--> statement-breakpoint

-- Backfill 1 (SPEC-0005 §7.5): the type-30/31 writers stored the ids in
-- `content` JSON ({old_project_id, project_id} add/remove shapes,
-- {project_id, project_column_id, project_column_title} for column moves);
-- upstream's type-30/31 content is EMPTY (the payload rides the columns).
-- Move each landed payload into its columns and blank the body. A row whose
-- content does not parse as JSON or misses the arm's keys is left verbatim
-- (the conservative arm — the timeline reader keeps its content fallbacks).
-- json_valid gates the parse; json_type pins the key's JSON kind so a
-- non-object payload or a null/string id fails the row untouched.
-- project_title is NOT recoverable from the old payload — the backfilled
-- metadata carries the two known keys only.
UPDATE `comments`
SET `old_project_id` = json_extract(`content`, '$.old_project_id'),
    `project_id` = json_extract(`content`, '$.project_id'),
    `content` = ''
WHERE `type` = 30
  AND json_valid(`content`)
  AND json_type(`content`, '$') = 'object'
  AND json_type(`content`, '$.old_project_id') IN ('integer', 'real')
  AND json_type(`content`, '$.project_id') IN ('integer', 'real');--> statement-breakpoint
UPDATE `comments`
SET `project_id` = json_extract(`content`, '$.project_id'),
    `comment_meta_data` = json_object(
      'project_column_id', json_extract(`content`, '$.project_column_id'),
      'project_column_title', json_extract(`content`, '$.project_column_title')
    ),
    `content` = ''
WHERE `type` = 31
  AND json_valid(`content`)
  AND json_type(`content`, '$') = 'object'
  AND json_type(`content`, '$.project_id') IN ('integer', 'real')
  AND json_type(`content`, '$.project_column_id') IN ('integer', 'real')
  AND json_type(`content`, '$.project_column_title') = 'text';--> statement-breakpoint

-- Backfill 2 (SPEC-0005 §7.5): stamp `time_id` on the time-family comments
-- the landed writers could not link — exactly trackedTimeOfComment's
-- documented correlation applied once (api/services/issues.ts):
--   - type 14 (add_time_manual): the `|<seconds>` content holds the entry's
--     seconds; the batch-mate is the newest live `tracked_time` row with
--     (issue_id, user_id = poster_id, seconds) created at or before the
--     comment's own second (the writer batch shares one Date, so the equal
--     second is the normal hit). A non-numeric marker parses to 0 and is
--     skipped (the reader's seconds != 0 gate). A row with no matching entry
--     keeps NULL and stays on the reader's legacy fallback.
--   - type 13 (stop_tracking): the newest live row created in the comment's
--     own second (the banked entry and the comment share the write Date).
-- delete/start/cancel arms carry no TimeID upstream — no backfill.
UPDATE `comments`
SET `time_id` = (
  SELECT `tt`.`id`
  FROM `tracked_time` `tt`
  WHERE `tt`.`issue_id` = `comments`.`issue_id`
    AND `tt`.`user_id` = `comments`.`poster_id`
    AND `tt`.`seconds` = CAST(substr(`comments`.`content`, 2) AS INTEGER)
    AND `tt`.`deleted` = 0
    AND `tt`.`created_unix` <= `comments`.`created_unix`
  ORDER BY `tt`.`id` DESC
  LIMIT 1
)
WHERE `type` = 14
  AND `poster_id` IS NOT NULL
  AND `created_unix` IS NOT NULL
  AND `content` LIKE '|%'
  AND CAST(substr(`content`, 2) AS INTEGER) != 0
  AND EXISTS (
    SELECT 1 FROM `tracked_time` `tt2`
    WHERE `tt2`.`issue_id` = `comments`.`issue_id`
      AND `tt2`.`user_id` = `comments`.`poster_id`
      AND `tt2`.`seconds` = CAST(substr(`comments`.`content`, 2) AS INTEGER)
      AND `tt2`.`deleted` = 0
      AND `tt2`.`created_unix` <= `comments`.`created_unix`
  );--> statement-breakpoint
UPDATE `comments`
SET `time_id` = (
  SELECT `tt`.`id`
  FROM `tracked_time` `tt`
  WHERE `tt`.`issue_id` = `comments`.`issue_id`
    AND `tt`.`user_id` = `comments`.`poster_id`
    AND `tt`.`deleted` = 0
    AND `tt`.`created_unix` = `comments`.`created_unix`
  ORDER BY `tt`.`id` DESC
  LIMIT 1
)
WHERE `type` = 13
  AND `poster_id` IS NOT NULL
  AND `created_unix` IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM `tracked_time` `tt2`
    WHERE `tt2`.`issue_id` = `comments`.`issue_id`
      AND `tt2`.`user_id` = `comments`.`poster_id`
      AND `tt2`.`deleted` = 0
      AND `tt2`.`created_unix` = `comments`.`created_unix`
  );--> statement-breakpoint

-- Backfill 3 (SPEC-0005 §7.5): the team review-request add arm wrote
-- (assignee_id NULL, review_id = the pull_reviews Request row); the team id
-- lives on that row's reviewer_team_id. User-request rows (reviewer_id > 0,
-- reviewer_team_id = 0) and removed arms (no review_id) keep the DEFAULT 0.
UPDATE `comments`
SET `assignee_team_id` = (
  SELECT `pr`.`reviewer_team_id`
  FROM `pull_reviews` `pr`
  WHERE `pr`.`id` = `comments`.`review_id`
)
WHERE `type` = 27
  AND `assignee_id` IS NULL
  AND `review_id` > 0
  AND EXISTS (
    SELECT 1 FROM `pull_reviews` `pr2`
    WHERE `pr2`.`id` = `comments`.`review_id`
      AND `pr2`.`reviewer_team_id` > 0
  );
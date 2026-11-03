-- Custom SQL migration file, put your code below! --
-- ADR-0007 FN-1: align `pull_requests.status` stored values with upstream's
-- PullRequestStatus iota (gitea/models/issues/pull.go:100-107). The column
-- stays INTEGER (no DDL); rows written under the old swapped mapping
-- (ManuallyMerged=2/Mergeable=3) are re-keyed to upstream's order
-- (Mergeable=2/ManuallyMerged=3). Single-statement CASE swap: 2<->3, all
-- other iota values (0,1,4,5,6) are position-stable and pass through.
UPDATE `pull_requests` SET `status` = CASE `status` WHEN 2 THEN 3 WHEN 3 THEN 2 ELSE `status` END;

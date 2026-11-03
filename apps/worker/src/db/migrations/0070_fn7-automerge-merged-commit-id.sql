-- ADR-0007 FN-7: pull_auto_merges completion — upstream's
-- `MergedCommitID xorm:"VARCHAR(64)"` (models/pull/automerge.go:26), the
-- recorded merge result stamped by the automerge winner arm
-- (services/pull/merge.go:265-274's recordMergeIntent). Nullable TEXT, no
-- default (a row that never completed its merge carries NULL); appended per
-- the ALTER ADD COLUMN convention. Ours-extra `sha` (the head-sha gate)
-- stays the recorded addition. Pure ADD — no rebuild, so the 0066 DQS trap
-- cannot apply (audited: single backtick-quoted statement, no data copy).
ALTER TABLE `pull_auto_merges` ADD `merged_commit_id` text;
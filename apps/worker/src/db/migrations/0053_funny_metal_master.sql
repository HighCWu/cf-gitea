ALTER TABLE `repo_watchers` ADD `mode` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `repo_watchers` ADD `include_pull_requests` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `repo_watchers` ADD `include_issues` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `repo_watchers` ADD `include_releases` integer DEFAULT true NOT NULL;
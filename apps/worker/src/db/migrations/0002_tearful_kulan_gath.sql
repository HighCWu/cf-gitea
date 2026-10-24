CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` integer NOT NULL,
	`poster_id` integer,
	`issue_id` integer NOT NULL,
	`label_id` integer,
	`old_milestone_id` integer,
	`milestone_id` integer,
	`assignee_id` integer,
	`removed_assignee` integer DEFAULT 0,
	`resolve_doer_id` integer,
	`old_title` text,
	`new_title` text,
	`old_ref` text,
	`new_ref` text,
	`dependent_issue_id` integer,
	`line` integer,
	`tree_path` text,
	`content` text,
	`content_version` integer DEFAULT 0 NOT NULL,
	`patch` text,
	`commit_sha` text,
	`review_id` integer DEFAULT 0,
	`invalidated` integer DEFAULT false NOT NULL,
	`ref_repo_id` text,
	`ref_issue_id` integer,
	`ref_comment_id` integer,
	`ref_action` integer,
	`ref_is_pull` integer DEFAULT false NOT NULL,
	`created_unix` integer,
	`updated_unix` integer
);
--> statement-breakpoint
CREATE INDEX `comments_issue_idx` ON `comments` (`issue_id`);--> statement-breakpoint
CREATE INDEX `comments_ref_issue_idx` ON `comments` (`ref_issue_id`);--> statement-breakpoint
CREATE INDEX `comments_ref_repo_idx` ON `comments` (`ref_repo_id`);--> statement-breakpoint
CREATE TABLE `commit_statuses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`sha` text NOT NULL,
	`target_url` text,
	`description` text DEFAULT '',
	`context` text DEFAULT 'default' NOT NULL,
	`state` text NOT NULL,
	`creator_id` integer,
	`created_unix` integer,
	`updated_unix` integer
);
--> statement-breakpoint
CREATE INDEX `commit_statuses_repo_sha_idx` ON `commit_statuses` (`repo_id`,`sha`);--> statement-breakpoint
CREATE TABLE `issue_labels` (
	`issue_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`)
);
--> statement-breakpoint
CREATE TABLE `issue_pins` (
	`issue_id` integer PRIMARY KEY NOT NULL,
	`repo_id` text,
	`pin_order` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `issue_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`is_watching` integer NOT NULL,
	`created_unix` integer,
	`updated_unix` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_subscriptions_user_issue_uq` ON `issue_subscriptions` (`user_id`,`issue_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`index` integer NOT NULL,
	`poster_id` integer,
	`original_author` text,
	`original_author_id` integer,
	`title` text NOT NULL,
	`content` text,
	`content_version` integer DEFAULT 0 NOT NULL,
	`milestone_id` integer,
	`priority` integer DEFAULT 0,
	`is_closed` integer DEFAULT false NOT NULL,
	`is_pull` integer DEFAULT false NOT NULL,
	`num_comments` integer DEFAULT 0 NOT NULL,
	`ref` text DEFAULT '',
	`is_locked` integer DEFAULT false NOT NULL,
	`time_estimate` integer DEFAULT 0 NOT NULL,
	`deadline_unix` integer,
	`created_unix` integer,
	`updated_unix` integer,
	`closed_unix` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_repo_index_uq` ON `issues` (`repo_id`,`index`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text,
	`org_id` integer DEFAULT 0,
	`name` text NOT NULL,
	`exclusive` integer DEFAULT false NOT NULL,
	`exclusive_order` integer DEFAULT 0,
	`description` text DEFAULT '',
	`color` text,
	`num_issues` integer DEFAULT 0,
	`num_closed_issues` integer DEFAULT 0,
	`archived_unix` integer
);
--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`name` text NOT NULL,
	`content` text DEFAULT '',
	`is_closed` integer DEFAULT false NOT NULL,
	`num_issues` integer DEFAULT 0,
	`num_closed_issues` integer DEFAULT 0,
	`completeness` integer DEFAULT 0,
	`deadline_unix` integer,
	`closed_date_unix` integer,
	`created_unix` integer,
	`updated_unix` integer
);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`index` integer NOT NULL,
	`status` integer DEFAULT 1 NOT NULL,
	`conflicted_files` text,
	`commits_ahead` integer DEFAULT 0,
	`commits_behind` integer DEFAULT 0,
	`head_repo_id` text NOT NULL,
	`base_repo_id` text NOT NULL,
	`head_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`merge_base` text,
	`head_sha` text,
	`allow_maintainer_edit` integer DEFAULT false NOT NULL,
	`has_merged` integer DEFAULT false NOT NULL,
	`merged_commit_id` text,
	`merger_id` integer,
	`merged_unix` integer,
	`flow` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_issue_id_uq` ON `pull_requests` (`issue_id`);--> statement-breakpoint
CREATE INDEX `pull_requests_head_idx` ON `pull_requests` (`head_repo_id`,`head_branch`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`comment_id` integer DEFAULT 0 NOT NULL,
	`release_id` integer DEFAULT 0 NOT NULL,
	`type` text NOT NULL,
	`created_unix` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reactions_target_uq` ON `reactions` (`user_id`,`issue_id`,`comment_id`,`release_id`,`type`);--> statement-breakpoint
CREATE TABLE `release_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uuid` text NOT NULL,
	`repo_id` text NOT NULL,
	`release_id` integer NOT NULL,
	`uploader_id` integer,
	`name` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`r2_key` text NOT NULL,
	`checksum_sha256` text,
	`created_unix` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_assets_uuid_uq` ON `release_assets` (`uuid`);--> statement-breakpoint
CREATE INDEX `release_assets_release_idx` ON `release_assets` (`release_id`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`publisher_id` integer NOT NULL,
	`tag_name` text NOT NULL,
	`lower_tag_name` text NOT NULL,
	`target` text DEFAULT '',
	`title` text DEFAULT '' NOT NULL,
	`sha1` text,
	`num_commits` integer DEFAULT 0,
	`note` text DEFAULT '',
	`is_draft` integer DEFAULT false NOT NULL,
	`is_prerelease` integer DEFAULT false NOT NULL,
	`is_tag` integer DEFAULT false NOT NULL,
	`created_unix` integer,
	`published_unix` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_repo_tag_uq` ON `releases` (`repo_id`,`tag_name`);--> statement-breakpoint
CREATE INDEX `releases_repo_created_idx` ON `releases` (`repo_id`,"created_unix" desc);--> statement-breakpoint
CREATE TABLE `repo_counters` (
	`repo_id` text PRIMARY KEY NOT NULL,
	`issue_index` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hook_id` integer NOT NULL,
	`repo_id` text NOT NULL,
	`uuid` text NOT NULL,
	`event_type` text NOT NULL,
	`event_group` text NOT NULL,
	`payload_content` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`is_succeed` integer DEFAULT false NOT NULL,
	`request_content` text,
	`response_content` text,
	`created_unix` integer,
	`delivered_unix` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_uuid_uq` ON `webhook_deliveries` (`uuid`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_hook_idx` ON `webhook_deliveries` (`hook_id`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text,
	`owner_id` integer,
	`is_system_webhook` integer DEFAULT false NOT NULL,
	`url` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`http_method` text DEFAULT 'POST' NOT NULL,
	`content_type` integer DEFAULT 1 NOT NULL,
	`secret` text DEFAULT '' NOT NULL,
	`events` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`type` text(16) DEFAULT 'gitea' NOT NULL,
	`meta` text DEFAULT '' NOT NULL,
	`last_status` integer DEFAULT 0 NOT NULL,
	`header_authorization_encrypted` text,
	`created_unix` integer,
	`updated_unix` integer
);
--> statement-breakpoint
CREATE INDEX `webhooks_repo_idx` ON `webhooks` (`repo_id`);--> statement-breakpoint
CREATE INDEX `webhooks_owner_idx` ON `webhooks` (`owner_id`);--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_issues` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_closed_issues` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_pulls` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_closed_pulls` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_milestones` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `close_issues_via_commit_in_any_branch` integer DEFAULT false NOT NULL;
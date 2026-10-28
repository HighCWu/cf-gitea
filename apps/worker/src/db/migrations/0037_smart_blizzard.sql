DROP INDEX `comments_ref_repo_idx`;--> statement-breakpoint
DROP INDEX `deploy_keys_token_hash_idx`;--> statement-breakpoint
DROP INDEX `issue_content_history_edited_idx`;--> statement-breakpoint
DROP INDEX `project_columns_created_idx`;--> statement-breakpoint
DROP INDEX `project_columns_updated_idx`;--> statement-breakpoint
DROP INDEX `projects_title_idx`;--> statement-breakpoint
DROP INDEX `repo_license_created_idx`;--> statement-breakpoint
DROP INDEX `repo_license_updated_idx`;--> statement-breakpoint
DROP INDEX `user_blocking_created_idx`;--> statement-breakpoint
CREATE INDEX `issue_labels_label_idx` ON `issue_labels` (`label_id`);--> statement-breakpoint
CREATE INDEX `issue_pins_repo_order_idx` ON `issue_pins` (`repo_id`,`pin_order`);--> statement-breakpoint
CREATE INDEX `issues_milestone_idx` ON `issues` (`milestone_id`);--> statement-breakpoint
CREATE INDEX `notification_states_issue_idx` ON `notification_states` (`issue_id`);--> statement-breakpoint
CREATE INDEX `pull_requests_base_index_idx` ON `pull_requests` (`base_repo_id`,`index`);--> statement-breakpoint
CREATE INDEX `release_assets_repo_idx` ON `release_assets` (`repo_id`);--> statement-breakpoint
CREATE INDEX `repo_mirrors_next_sync_idx` ON `repo_mirrors` (`next_sync_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_repo_idx` ON `webhook_deliveries` (`repo_id`);
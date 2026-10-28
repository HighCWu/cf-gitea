CREATE INDEX `action_repo_deleted_created_idx` ON `action` (`repo_id`,`is_deleted`,`created_unix`);--> statement-breakpoint
CREATE INDEX `comments_poster_created_idx` ON `comments` (`poster_id`,`created_unix`);--> statement-breakpoint
CREATE INDEX `issue_subscriptions_issue_idx` ON `issue_subscriptions` (`issue_id`);--> statement-breakpoint
CREATE INDEX `issues_repo_pull_closed_created_idx` ON `issues` (`repo_id`,`is_pull`,`is_closed`,`created_unix`);--> statement-breakpoint
CREATE INDEX `issues_poster_created_idx` ON `issues` (`poster_id`,`created_unix`);--> statement-breakpoint
CREATE INDEX `labels_repo_id_idx` ON `labels` (`repo_id`);--> statement-breakpoint
CREATE INDEX `labels_org_id_idx` ON `labels` (`org_id`);--> statement-breakpoint
CREATE INDEX `milestones_repo_id_idx` ON `milestones` (`repo_id`);--> statement-breakpoint
CREATE INDEX `reactions_issue_comment_release_idx` ON `reactions` (`issue_id`,`comment_id`,`release_id`);--> statement-breakpoint
CREATE INDEX `repositories_owner_id_idx` ON `repositories` (`owner_id`);
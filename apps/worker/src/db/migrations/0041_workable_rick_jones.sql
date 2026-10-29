CREATE TABLE `action_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`run_attempt_id` integer DEFAULT 0 NOT NULL,
	`runner_id` integer DEFAULT 0 NOT NULL,
	`repo_id` text NOT NULL,
	`owner_id` integer DEFAULT 0 NOT NULL,
	`commit_sha` text DEFAULT '' NOT NULL,
	`storage_path` text DEFAULT '' NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`file_compressed_size` integer DEFAULT 0 NOT NULL,
	`content_encoding` text DEFAULT '' NOT NULL,
	`artifact_path` text DEFAULT '' NOT NULL,
	`artifact_name` text DEFAULT '' NOT NULL,
	`status` integer DEFAULT 1 NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	`expired_unix` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_artifacts_run_attempt_name_path_uq` ON `action_artifacts` (`run_id`,`run_attempt_id`,`artifact_path`,`artifact_name`);--> statement-breakpoint
CREATE INDEX `action_artifacts_run_id_idx` ON `action_artifacts` (`run_id`);--> statement-breakpoint
CREATE INDEX `action_artifacts_repo_id_idx` ON `action_artifacts` (`repo_id`);--> statement-breakpoint
CREATE INDEX `action_artifacts_status_idx` ON `action_artifacts` (`status`);--> statement-breakpoint
CREATE INDEX `action_artifacts_updated_idx` ON `action_artifacts` (`updated`);--> statement-breakpoint
CREATE INDEX `action_artifacts_expired_unix_idx` ON `action_artifacts` (`expired_unix`);--> statement-breakpoint
CREATE TABLE `action_log_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`bytes` blob NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_log_chunks_task_seq_uq` ON `action_log_chunks` (`task_id`,`seq`);--> statement-breakpoint
CREATE INDEX `action_log_chunks_task_id_idx` ON `action_log_chunks` (`task_id`);--> statement-breakpoint
CREATE TABLE `action_run_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`run_id` integer NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`trigger_user_id` integer DEFAULT 0 NOT NULL,
	`concurrency_group` text DEFAULT '' NOT NULL,
	`concurrency_cancel` integer DEFAULT false NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`started` integer,
	`stopped` integer,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_run_attempts_run_attempt_uq` ON `action_run_attempts` (`run_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `action_run_attempts_repo_concurrency_status_idx` ON `action_run_attempts` (`repo_id`,`concurrency_group`,`status`);--> statement-breakpoint
CREATE INDEX `action_run_attempts_status_idx` ON `action_run_attempts` (`status`);--> statement-breakpoint
CREATE TABLE `action_run_job_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`run_id` integer NOT NULL,
	`run_attempt_id` integer DEFAULT 0 NOT NULL,
	`job_id` integer NOT NULL,
	`step_index` integer NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`content_type` text DEFAULT 'text/markdown' NOT NULL,
	`content_size` integer DEFAULT 0 NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_run_job_summaries_summary_key_uq` ON `action_run_job_summaries` (`repo_id`,`run_id`,`run_attempt_id`,`job_id`,`step_index`);--> statement-breakpoint
CREATE TABLE `action_run_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`repo_id` text NOT NULL,
	`owner_id` integer NOT NULL,
	`commit_sha` text DEFAULT '' NOT NULL,
	`is_fork_pull_request` integer DEFAULT false NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`workflow_payload` blob NOT NULL,
	`job_id` text DEFAULT '' NOT NULL,
	`needs` text DEFAULT '[]' NOT NULL,
	`runs_on` text DEFAULT '[]' NOT NULL,
	`task_id` integer DEFAULT 0 NOT NULL,
	`source_task_id` integer DEFAULT 0 NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`raw_concurrency` text DEFAULT '' NOT NULL,
	`is_concurrency_evaluated` integer DEFAULT false NOT NULL,
	`concurrency_group` text DEFAULT '' NOT NULL,
	`concurrency_cancel` integer DEFAULT false NOT NULL,
	`token_permissions` text,
	`max_parallel` integer DEFAULT 0 NOT NULL,
	`is_matrix_deferred` integer DEFAULT false NOT NULL,
	`deferred_matrix_payload` blob,
	`run_attempt_id` integer DEFAULT 0 NOT NULL,
	`attempt_job_id` integer DEFAULT 0 NOT NULL,
	`workflow_source_repo_id` text DEFAULT '' NOT NULL,
	`workflow_source_commit_sha` text DEFAULT '' NOT NULL,
	`is_reusable_caller` integer DEFAULT false NOT NULL,
	`is_expanded` integer DEFAULT false NOT NULL,
	`call_uses` text DEFAULT '' NOT NULL,
	`reusable_workflow_content` blob,
	`reusable_workflow_ref` text DEFAULT '' NOT NULL,
	`call_secrets` text DEFAULT '' NOT NULL,
	`call_payload` text DEFAULT '' NOT NULL,
	`parent_job_id` integer DEFAULT 0 NOT NULL,
	`continue_on_error` integer DEFAULT false NOT NULL,
	`started` integer,
	`stopped` integer,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `action_run_jobs_run_id_idx` ON `action_run_jobs` (`run_id`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_repo_status_idx` ON `action_run_jobs` (`repo_id`,`status`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_owner_id_idx` ON `action_run_jobs` (`owner_id`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_commit_sha_idx` ON `action_run_jobs` (`commit_sha`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_pickup_idx` ON `action_run_jobs` (`task_id`,`status`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_status_idx` ON `action_run_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_repo_concurrency_idx` ON `action_run_jobs` (`repo_id`,`concurrency_group`,`status`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_run_attempt_id_idx` ON `action_run_jobs` (`run_attempt_id`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_attempt_job_id_idx` ON `action_run_jobs` (`attempt_job_id`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_is_reusable_caller_idx` ON `action_run_jobs` (`is_reusable_caller`);--> statement-breakpoint
CREATE INDEX `action_run_jobs_parent_job_id_idx` ON `action_run_jobs` (`parent_job_id`);--> statement-breakpoint
CREATE TABLE `action_runner_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`owner_id` integer DEFAULT 0 NOT NULL,
	`repo_id` text DEFAULT '' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	`deleted` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_runner_tokens_token_unique` ON `action_runner_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `action_runner_tokens_owner_id_idx` ON `action_runner_tokens` (`owner_id`);--> statement-breakpoint
CREATE INDEX `action_runner_tokens_repo_id_idx` ON `action_runner_tokens` (`repo_id`);--> statement-breakpoint
CREATE TABLE `action_runners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uuid` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`version` text DEFAULT '' NOT NULL,
	`owner_id` integer DEFAULT 0 NOT NULL,
	`repo_id` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`base` integer DEFAULT 0 NOT NULL,
	`repo_range` text DEFAULT '' NOT NULL,
	`token_hash` text NOT NULL,
	`token_salt` text DEFAULT '' NOT NULL,
	`last_online` integer,
	`last_active` integer,
	`agent_labels` text DEFAULT '[]' NOT NULL,
	`ephemeral` integer DEFAULT false NOT NULL,
	`is_disabled` integer DEFAULT false NOT NULL,
	`has_cancelling_support` integer DEFAULT false NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	`deleted` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_runners_uuid_unique` ON `action_runners` (`uuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `action_runners_token_hash_unique` ON `action_runners` (`token_hash`);--> statement-breakpoint
CREATE INDEX `action_runners_owner_id_idx` ON `action_runners` (`owner_id`);--> statement-breakpoint
CREATE INDEX `action_runners_repo_id_idx` ON `action_runners` (`repo_id`);--> statement-breakpoint
CREATE INDEX `action_runners_last_online_idx` ON `action_runners` (`last_online`);--> statement-breakpoint
CREATE INDEX `action_runners_last_active_idx` ON `action_runners` (`last_active`);--> statement-breakpoint
CREATE TABLE `action_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`repo_id` text NOT NULL,
	`owner_id` integer NOT NULL,
	`workflow_id` text DEFAULT '' NOT NULL,
	`index` integer NOT NULL,
	`trigger_user_id` integer DEFAULT 0 NOT NULL,
	`schedule_id` integer DEFAULT 0 NOT NULL,
	`ref` text DEFAULT '' NOT NULL,
	`commit_sha` text DEFAULT '' NOT NULL,
	`is_fork_pull_request` integer DEFAULT false NOT NULL,
	`need_approval` integer DEFAULT false NOT NULL,
	`approved_by` integer DEFAULT 0 NOT NULL,
	`event` text DEFAULT '' NOT NULL,
	`event_payload` text DEFAULT '{}' NOT NULL,
	`trigger_event` text DEFAULT '' NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`raw_concurrency` text DEFAULT '' NOT NULL,
	`workflow_repo_id` text DEFAULT '' NOT NULL,
	`workflow_commit_sha` text DEFAULT '' NOT NULL,
	`is_scoped_run` integer DEFAULT false NOT NULL,
	`started` integer,
	`stopped` integer,
	`previous_duration` integer DEFAULT 0 NOT NULL,
	`latest_attempt_id` integer DEFAULT 0 NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_runs_repo_index_uq` ON `action_runs` (`repo_id`,`index`);--> statement-breakpoint
CREATE INDEX `action_runs_repo_status_idx` ON `action_runs` (`repo_id`,`status`);--> statement-breakpoint
CREATE INDEX `action_runs_owner_id_idx` ON `action_runs` (`owner_id`);--> statement-breakpoint
CREATE INDEX `action_runs_workflow_id_idx` ON `action_runs` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `action_runs_trigger_user_id_idx` ON `action_runs` (`trigger_user_id`);--> statement-breakpoint
CREATE INDEX `action_runs_ref_idx` ON `action_runs` (`ref`);--> statement-breakpoint
CREATE INDEX `action_runs_commit_sha_idx` ON `action_runs` (`commit_sha`);--> statement-breakpoint
CREATE INDEX `action_runs_status_idx` ON `action_runs` (`status`);--> statement-breakpoint
CREATE INDEX `action_runs_approved_by_idx` ON `action_runs` (`approved_by`);--> statement-breakpoint
CREATE INDEX `action_runs_latest_attempt_id_idx` ON `action_runs` (`latest_attempt_id`);--> statement-breakpoint
CREATE TABLE `action_task_outputs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`output_key` text NOT NULL,
	`output_value` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_task_outputs_task_key_uq` ON `action_task_outputs` (`task_id`,`output_key`);--> statement-breakpoint
CREATE INDEX `action_task_outputs_task_id_idx` ON `action_task_outputs` (`task_id`);--> statement-breakpoint
CREATE TABLE `action_task_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`task_id` integer NOT NULL,
	`index` integer NOT NULL,
	`repo_id` text NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`log_index` integer DEFAULT 0 NOT NULL,
	`log_length` integer DEFAULT 0 NOT NULL,
	`stage` integer DEFAULT 0 NOT NULL,
	`number` integer DEFAULT 0 NOT NULL,
	`started` integer,
	`stopped` integer,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_task_steps_task_index_uq` ON `action_task_steps` (`task_id`,`index`);--> statement-breakpoint
CREATE INDEX `action_task_steps_index_idx` ON `action_task_steps` (`index`);--> statement-breakpoint
CREATE INDEX `action_task_steps_repo_id_idx` ON `action_task_steps` (`repo_id`);--> statement-breakpoint
CREATE INDEX `action_task_steps_status_idx` ON `action_task_steps` (`status`);--> statement-breakpoint
CREATE TABLE `action_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`runner_id` integer DEFAULT 0 NOT NULL,
	`status` integer DEFAULT 0 NOT NULL,
	`started` integer,
	`stopped` integer,
	`repo_id` text NOT NULL,
	`owner_id` integer NOT NULL,
	`commit_sha` text DEFAULT '' NOT NULL,
	`is_fork_pull_request` integer DEFAULT false NOT NULL,
	`token_hash` text NOT NULL,
	`token_salt` text DEFAULT '' NOT NULL,
	`token_last_eight` text DEFAULT '' NOT NULL,
	`log_filename` text DEFAULT '' NOT NULL,
	`log_in_storage` integer DEFAULT false NOT NULL,
	`log_length` integer DEFAULT 0 NOT NULL,
	`log_size` integer DEFAULT 0 NOT NULL,
	`log_indexes` blob,
	`log_expired` integer DEFAULT false NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_tasks_token_hash_unique` ON `action_tasks` (`token_hash`);--> statement-breakpoint
CREATE INDEX `action_tasks_runner_id_idx` ON `action_tasks` (`runner_id`);--> statement-breakpoint
CREATE INDEX `action_tasks_status_idx` ON `action_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `action_tasks_started_idx` ON `action_tasks` (`started`);--> statement-breakpoint
CREATE INDEX `action_tasks_stopped_log_expired_idx` ON `action_tasks` (`stopped`,`log_expired`);--> statement-breakpoint
CREATE INDEX `action_tasks_repo_id_idx` ON `action_tasks` (`repo_id`);--> statement-breakpoint
CREATE INDEX `action_tasks_owner_id_idx` ON `action_tasks` (`owner_id`);--> statement-breakpoint
CREATE INDEX `action_tasks_commit_sha_idx` ON `action_tasks` (`commit_sha`);--> statement-breakpoint
CREATE INDEX `action_tasks_token_last_eight_idx` ON `action_tasks` (`token_last_eight`);--> statement-breakpoint
CREATE INDEX `action_tasks_updated_idx` ON `action_tasks` (`updated`);--> statement-breakpoint
CREATE TABLE `action_tasks_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer DEFAULT 0 NOT NULL,
	`repo_id` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_tasks_versions_owner_repo_uq` ON `action_tasks_versions` (`owner_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX `action_tasks_versions_repo_id_idx` ON `action_tasks_versions` (`repo_id`);
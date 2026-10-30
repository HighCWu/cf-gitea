CREATE TABLE `cron_state` (
	`arm` text PRIMARY KEY NOT NULL,
	`last_success_unix` integer,
	`last_error` text,
	`last_error_unix` integer,
	`runs` integer DEFAULT 0 NOT NULL
);

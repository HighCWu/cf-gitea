CREATE TABLE `audit_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`actor_id` integer NOT NULL,
	`actor_name` text DEFAULT '' NOT NULL,
	`actor_credential` text,
	`impersonator_id` integer DEFAULT 0 NOT NULL,
	`impersonator_name` text,
	`scope_type` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`scope_name` text,
	`origin` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`metadata` text,
	`ip_address` text,
	`created_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_event_action` ON `audit_event` (`action`);--> statement-breakpoint
CREATE INDEX `idx_audit_event_actor` ON `audit_event` (`actor_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_event_impersonator` ON `audit_event` (`impersonator_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_event_created` ON `audit_event` (`created_unix`);--> statement-breakpoint
CREATE INDEX `idx_audit_event_scope_created` ON `audit_event` (`scope_type`,`scope_id`,`created_unix`);
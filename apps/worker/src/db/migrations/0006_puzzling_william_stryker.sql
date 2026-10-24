CREATE TABLE `repo_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` text NOT NULL,
	`import_token_sha256` text NOT NULL,
	`state` text DEFAULT 'staged' NOT NULL,
	`manifest` text,
	`staged` text,
	`chunk_cap` integer NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`error` text,
	`heartbeat_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_imports_token_uq` ON `repo_imports` (`import_token_sha256`);--> statement-breakpoint
CREATE INDEX `repo_imports_repo_idx` ON `repo_imports` (`repo_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `repo_imports_active_uq` ON `repo_imports` (`repo_id`) WHERE state IN ('staged', 'indexing', 'finalizing');
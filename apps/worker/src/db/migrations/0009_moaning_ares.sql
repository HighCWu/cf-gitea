ALTER TABLE `repositories` ADD `fork_parent` text;--> statement-breakpoint
CREATE INDEX `repositories_fork_parent_idx` ON `repositories` (`fork_parent`);
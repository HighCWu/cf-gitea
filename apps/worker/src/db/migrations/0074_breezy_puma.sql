ALTER TABLE `users` ADD `passwd` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `passwd_hash_algo` text DEFAULT 'argon2' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `salt` text(32) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `rands` text(32) DEFAULT '' NOT NULL;
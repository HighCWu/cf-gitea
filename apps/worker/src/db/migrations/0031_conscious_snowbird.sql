ALTER TABLE `repositories` ADD `num_forks` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `num_stars` integer DEFAULT 0 NOT NULL;
ALTER TABLE `repositories` ADD `num_stars` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repositories` ADD `num_watches` integer DEFAULT 0 NOT NULL;
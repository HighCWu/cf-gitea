ALTER TABLE `sessions` ADD `impersonator_user_id` integer REFERENCES `users`(`id`) ON DELETE CASCADE;

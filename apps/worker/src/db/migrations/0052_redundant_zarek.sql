CREATE TABLE `oauth2_authorization_code` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`grant_id` integer NOT NULL,
	`code` text NOT NULL,
	`code_challenge` text DEFAULT '' NOT NULL,
	`code_challenge_method` text DEFAULT '' NOT NULL,
	`redirect_uri` text DEFAULT '' NOT NULL,
	`valid_until` integer NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth2_grant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth2_authorization_code_code_uq` ON `oauth2_authorization_code` (`code`);--> statement-breakpoint
CREATE INDEX `oauth2_authorization_code_valid_until_idx` ON `oauth2_authorization_code` (`valid_until`);--> statement-breakpoint
CREATE TABLE `oauth2_grant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`application_id` integer NOT NULL,
	`counter` integer DEFAULT 1 NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`nonce` text DEFAULT '' NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `oauth2_application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth2_grant_user_application_uq` ON `oauth2_grant` (`user_id`,`application_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `oauth_state` text;--> statement-breakpoint
-- The builtin applications (SPEC specs/oauth2-provider.md §2.9, upstream
-- BuiltinApplications gitea/models/auth/oauth2.go:68-101): five fixed-client
-- native apps so `git credential` OAuth (GCM, git-credential-oauth, tea, the
-- mobile app, the vscode extension) works out of the box. uid=0
-- (instance-owned), confidential_client=false (RFC 8252 native apps — the
-- zero value of upstream's plain `db.Insert` with only Name/ClientID/
-- RedirectURIs set), empty client_secret (no secret — public clients), the
-- exact hard-coded redirect URI lists verbatim. INSERT OR IGNORE rides the
-- `client_id` UNIQUE index: idempotent across re-runs, never clobbers an
-- operator's edits. Upstream's config-driven add/remove reconciliation
-- (Init's DEFAULT_APPLICATIONS, oauth2.go:103-157) is deliberately not
-- ported — the seeded set IS the upstream default set (SPEC §2.9).
INSERT OR IGNORE INTO `oauth2_application` (`uid`, `name`, `client_id`, `client_secret`, `confidential_client`, `skip_secondary_authorization`, `redirect_uris`, `created_unix`, `updated_unix`) VALUES (0, 'git-credential-oauth', 'a4792ccc-144e-407e-86c9-5e7d8d9c3269', '', 0, 0, '["http://127.0.0.1","https://127.0.0.1"]', unixepoch(), unixepoch());--> statement-breakpoint
INSERT OR IGNORE INTO `oauth2_application` (`uid`, `name`, `client_id`, `client_secret`, `confidential_client`, `skip_secondary_authorization`, `redirect_uris`, `created_unix`, `updated_unix`) VALUES (0, 'Git Credential Manager', 'e90ee53c-94e2-48ac-9358-a874fb9e0662', '', 0, 0, '["http://127.0.0.1","https://127.0.0.1"]', unixepoch(), unixepoch());--> statement-breakpoint
INSERT OR IGNORE INTO `oauth2_application` (`uid`, `name`, `client_id`, `client_secret`, `confidential_client`, `skip_secondary_authorization`, `redirect_uris`, `created_unix`, `updated_unix`) VALUES (0, 'tea', 'd57cb8c4-630c-4168-8324-ec79935e18d4', '', 0, 0, '["http://127.0.0.1","https://127.0.0.1"]', unixepoch(), unixepoch());--> statement-breakpoint
INSERT OR IGNORE INTO `oauth2_application` (`uid`, `name`, `client_id`, `client_secret`, `confidential_client`, `skip_secondary_authorization`, `redirect_uris`, `created_unix`, `updated_unix`) VALUES (0, 'Gitea App', 'b757811a-05c8-4c76-8d74-a5ee3d2073f2', '', 0, 0, '["com.gitea.app://oauth/callback"]', unixepoch(), unixepoch());--> statement-breakpoint
INSERT OR IGNORE INTO `oauth2_application` (`uid`, `name`, `client_id`, `client_secret`, `confidential_client`, `skip_secondary_authorization`, `redirect_uris`, `created_unix`, `updated_unix`) VALUES (0, 'gitea-vscode', '75a9ec3e-42b5-40cb-9144-9ea96ecd56a6', '', 0, 0, '["http://127.0.0.1","https://127.0.0.1","vscode://gitea.gitea-for-vscode/auth/callback","vscode-insiders://gitea.gitea-for-vscode/auth/callback"]', unixepoch(), unixepoch());
CREATE TABLE `webauthn_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`lower_name` text NOT NULL,
	`credential_id` blob NOT NULL,
	`public_key` blob NOT NULL,
	`attestation_type` text NOT NULL,
	`aaguid` blob,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`clone_warning` integer DEFAULT false NOT NULL,
	`created_unix` integer NOT NULL,
	`updated_unix` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_credentials_user_lower_name_uq` ON `webauthn_credentials` (`user_id`,`lower_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_credentials_credential_id_uq` ON `webauthn_credentials` (`credential_id`);
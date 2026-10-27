CREATE TABLE `cooldown_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subject` text NOT NULL,
	`subject_name` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_name` text NOT NULL,
	`model_id` text NOT NULL,
	`model_alias` text NOT NULL,
	`credential_id` text,
	`credential_name` text,
	`error_kind` text NOT NULL,
	`reference` text NOT NULL,
	`failures` integer NOT NULL,
	`cooldown_ms` integer NOT NULL,
	`flagged_until` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cooldown_events_user_created` ON `cooldown_events` (`user_id`,`created_at`);
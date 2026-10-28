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
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cooldown_events_user_created` ON `cooldown_events` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `provider_credentials` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_credentials` ADD `flagged_until` integer;--> statement-breakpoint
ALTER TABLE `provider_models` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_models` ADD `flagged_until` integer;--> statement-breakpoint
ALTER TABLE `providers` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `flagged_until` integer;
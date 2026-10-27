CREATE TABLE `provider_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`sealed_key` text NOT NULL,
	`auth_mode` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`flagged_until` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_credentials_provider_created` ON `provider_credentials` (`provider_id`,`created_at`);--> statement-breakpoint
INSERT INTO provider_credentials (id, user_id, provider_id, name, sealed_key, auth_mode, failures, flagged_until, created_at)
  SELECT hex(randomblob(16)), user_id, id, '', api_key, auth_mode, 0, NULL, created_at FROM providers WHERE api_key <> '';--> statement-breakpoint
ALTER TABLE `provider_models` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_models` ADD `flagged_until` integer;--> statement-breakpoint
ALTER TABLE `providers` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `flagged_until` integer;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `api_key`;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `auth_mode`;

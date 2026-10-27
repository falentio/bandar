CREATE TABLE `provider_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`credential` text NOT NULL,
	`auth_mode` text DEFAULT 'api-key' NOT NULL,
	`priority` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credentials_provider_priority` ON `provider_credentials` (`provider_id`,`priority`);--> statement-breakpoint
INSERT INTO `provider_credentials` (`id`, `provider_id`, `label`, `credential`, `auth_mode`, `priority`, `created_at`)
SELECT lower(hex(randomblob(16))), `id`, '', `api_key`, `auth_mode`, 1, `created_at`
FROM `providers`
WHERE `api_key` <> '';--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `api_key`;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `auth_mode`;
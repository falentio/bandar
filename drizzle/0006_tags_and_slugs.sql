CREATE TABLE `tag_models` (
	`tag_id` text NOT NULL,
	`model_id` text NOT NULL,
	`priority` integer NOT NULL,
	PRIMARY KEY(`tag_id`, `model_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `provider_models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_models_tag_priority` ON `tag_models` (`tag_id`,`priority`);--> statement-breakpoint
CREATE INDEX `tag_models_model` ON `tag_models` (`model_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_slug` ON `tags` (`user_id`,`slug`);--> statement-breakpoint
ALTER TABLE `providers` ADD `slug` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `providers_user_slug` ON `providers` (`user_id`,`slug`) WHERE "providers"."slug" <> '';
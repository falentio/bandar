ALTER TABLE `provider_models` RENAME COLUMN `alias` TO `slug`;
--> statement-breakpoint
DROP INDEX IF EXISTS `provider_models_user_alias`;
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_models_user_slug` ON `provider_models` (`user_id`,`slug`);
--> statement-breakpoint
ALTER TABLE `provider_models` ADD `alias` text;
--> statement-breakpoint
UPDATE `provider_models` SET `alias` = NULLIF(`slug`, `upstream_model`);
--> statement-breakpoint
ALTER TABLE `cooldown_events` RENAME COLUMN `model_alias` TO `model_slug`;

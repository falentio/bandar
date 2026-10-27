DROP INDEX `provider_models_provider`;--> statement-breakpoint
CREATE TEMP TABLE `duplicate_models` AS
SELECT `duplicate`.`id` AS `duplicate_id`, `keeper`.`id` AS `keeper_id`
FROM `provider_models` AS `duplicate`
JOIN `provider_models` AS `keeper`
  ON `keeper`.`provider_id` = `duplicate`.`provider_id`
 AND `keeper`.`upstream_model` = `duplicate`.`upstream_model`
 AND (
   `keeper`.`created_at` < `duplicate`.`created_at`
   OR (`keeper`.`created_at` = `duplicate`.`created_at` AND `keeper`.`id` < `duplicate`.`id`)
 )
WHERE `keeper`.`id` = (
  SELECT `first`.`id`
  FROM `provider_models` AS `first`
  WHERE `first`.`provider_id` = `duplicate`.`provider_id`
    AND `first`.`upstream_model` = `duplicate`.`upstream_model`
    AND (
      `first`.`created_at` < `duplicate`.`created_at`
      OR (`first`.`created_at` = `duplicate`.`created_at` AND `first`.`id` < `duplicate`.`id`)
    )
  ORDER BY `first`.`created_at`, `first`.`id`
  LIMIT 1
);--> statement-breakpoint
DELETE FROM `tag_models`
WHERE EXISTS (
  SELECT 1
  FROM `duplicate_models` AS `map`
  JOIN `tag_models` AS `keeper_link`
    ON `keeper_link`.`tag_id` = `tag_models`.`tag_id`
   AND `keeper_link`.`model_id` = `map`.`keeper_id`
  WHERE `map`.`duplicate_id` = `tag_models`.`model_id`
);--> statement-breakpoint
UPDATE `tag_models`
SET `model_id` = (
  SELECT `map`.`keeper_id`
  FROM `duplicate_models` AS `map`
  WHERE `map`.`duplicate_id` = `tag_models`.`model_id`
)
WHERE `model_id` IN (SELECT `duplicate_id` FROM `duplicate_models`);--> statement-breakpoint
DELETE FROM `provider_models`
WHERE `id` IN (SELECT `duplicate_id` FROM `duplicate_models`);--> statement-breakpoint
DROP TABLE `duplicate_models`;--> statement-breakpoint
CREATE UNIQUE INDEX `provider_models_provider_upstream` ON `provider_models` (`provider_id`,`upstream_model`);

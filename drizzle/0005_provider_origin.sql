ALTER TABLE `providers` ADD `origin` text DEFAULT 'custom' NOT NULL;
--> statement-breakpoint
UPDATE `providers` SET `origin` = 'builtin' WHERE `kind` = 'kilocode';

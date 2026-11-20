-- Write-up time is now "minutes per hour of lecture" (default 60). Old modules on the previous
-- default (90 per lecture) move to the new default. The column default itself isn't rebuilt
-- (that needs a table rebuild, which would cascade-delete lectures inside the migration
-- transaction); new modules always set the value explicitly.
UPDATE `modules` SET `write_up_minutes` = 60 WHERE `write_up_minutes` = 90;--> statement-breakpoint
ALTER TABLE `lectures` ADD `flashcards_at` text;

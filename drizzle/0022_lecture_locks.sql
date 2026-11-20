ALTER TABLE `lectures` ADD `title_locked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `modules` ADD `auto_organise` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `moodle_items` ADD `lecture_locked` integer DEFAULT false NOT NULL;
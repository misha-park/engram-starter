ALTER TABLE `lectures` ADD `title` text;--> statement-breakpoint
ALTER TABLE `moodle_items` ADD `lecture_id` text REFERENCES lectures(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `moodle_items` ADD `lecture_matched` integer DEFAULT false NOT NULL;
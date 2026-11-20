ALTER TABLE `blocks` ADD `detached` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `recurrences` ADD `exdates` text DEFAULT '[]' NOT NULL;
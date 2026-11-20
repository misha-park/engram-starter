CREATE TABLE `diss_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`due` text NOT NULL,
	`done_at` text
);
--> statement-breakpoint
CREATE TABLE `diss_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'not-started' NOT NULL,
	`word_count` integer,
	`word_target` integer,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `dissertation` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`module_id` text,
	`submission_due` text,
	`viva_date` text,
	`viva_time` text,
	`word_target` integer,
	`started_on` text,
	`zotero_collection_key` text,
	`zotero_collection_name` text,
	`zotero_synced_at` text,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `meeting_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`todo_id` text,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reading_items` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`creators` text DEFAULT '' NOT NULL,
	`year` text,
	`item_type` text NOT NULL,
	`publication` text,
	`doi` text,
	`url` text,
	`status` text DEFAULT 'to-read' NOT NULL,
	`section_ids` text DEFAULT '[]' NOT NULL,
	`missing` integer DEFAULT false NOT NULL
);

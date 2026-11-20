CREATE TABLE `moodle_courses` (
	`id` integer PRIMARY KEY NOT NULL,
	`shortname` text NOT NULL,
	`fullname` text NOT NULL,
	`module_id` text,
	`matched_by` text DEFAULT 'auto' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `moodle_items` (
	`key` text PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`kind` text NOT NULL,
	`section` text NOT NULL,
	`week` integer,
	`title` text NOT NULL,
	`modified` integer NOT NULL,
	`attachment_id` text,
	`dismissed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE set null
);

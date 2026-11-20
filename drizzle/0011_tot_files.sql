CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`stored_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`target_type` text,
	`target_id` text,
	`added_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tot_links` (
	`todo_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`done` integer NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade
);

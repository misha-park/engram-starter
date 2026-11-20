CREATE TABLE `assignment_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`estimate_minutes` integer NOT NULL,
	`done_at` text,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`title` text NOT NULL,
	`due` text NOT NULL,
	`type` text NOT NULL,
	`weighting` integer,
	`word_limit` integer,
	`brief_link` text,
	`is_group` integer DEFAULT false NOT NULL,
	`notes` text,
	`submitted_at` text,
	`unplaced_minutes` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);

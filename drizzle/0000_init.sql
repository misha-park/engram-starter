CREATE TABLE `blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`category_id` text,
	`linked_type` text,
	`linked_id` text,
	`source` text NOT NULL,
	`outcome` text DEFAULT 'none' NOT NULL,
	`recurrence_id` text,
	`occurrence_date` text,
	`debrief_pending` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recurrence_id`) REFERENCES `recurrences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `blocks_start_idx` ON `blocks` (`start`);--> statement-breakpoint
CREATE UNIQUE INDEX `blocks_occurrence_idx` ON `blocks` (`recurrence_id`,`occurrence_date`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`short_label` text NOT NULL,
	`colour` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `change_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	`actor` text NOT NULL,
	`batch_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	`undone_at` text
);
--> statement-breakpoint
CREATE TABLE `module_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`module_id` text NOT NULL,
	`feed_name` text NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `module_aliases_feed_name_unique` ON `module_aliases` (`feed_name`);--> statement-breakpoint
CREATE TABLE `modules` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`write_up_minutes` integer DEFAULT 90 NOT NULL,
	`folder_path` text,
	`assessment_notes` text,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `modules_category_id_unique` ON `modules` (`category_id`);--> statement-breakpoint
CREATE TABLE `records_index` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`path` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `records_entity_idx` ON `records_index` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `recurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`category_id` text,
	`rule` text NOT NULL,
	`starts_on` text NOT NULL,
	`until` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`block_id` text,
	`start` text NOT NULL,
	`end` text,
	`minutes` integer DEFAULT 0 NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`linked_type` text,
	`linked_id` text,
	`outcome` text,
	`debrief` text,
	`checkin_pending` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sessions_start_idx` ON `sessions` (`start`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `todos` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`due_date` text,
	`linked_type` text,
	`linked_id` text,
	`recurrence` text,
	`source` text DEFAULT 'app' NOT NULL,
	`tot_line_id` text,
	`done_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);

CREATE TABLE `lectures` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`block_id` text NOT NULL,
	`number` integer NOT NULL,
	`write_up_block_id` text,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`write_up_block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lectures_block_id_unique` ON `lectures` (`block_id`);--> statement-breakpoint
CREATE TABLE `timetable_events` (
	`uid` text PRIMARY KEY NOT NULL,
	`module_name` text NOT NULL,
	`level` integer,
	`feed_type` text NOT NULL,
	`type` text,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`block_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `timetable_events_block_idx` ON `timetable_events` (`block_id`);--> statement-breakpoint
ALTER TABLE `blocks` ADD `attention` text;
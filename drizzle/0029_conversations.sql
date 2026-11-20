CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`mode` text NOT NULL,
	`messages` text NOT NULL,
	`session_id` text,
	`open` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	`updated_at` text NOT NULL
);

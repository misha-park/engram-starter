CREATE TABLE `lecture_merges` (
	`id` text PRIMARY KEY NOT NULL,
	`uids` text NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);

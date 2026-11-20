CREATE TABLE `lecture_splits` (
	`uid` text PRIMARY KEY NOT NULL,
	`cuts` text NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);

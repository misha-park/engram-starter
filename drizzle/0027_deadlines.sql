CREATE TABLE `deadlines` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`due` text NOT NULL,
	`module_id` text,
	`notes` text,
	`done_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE set null
);

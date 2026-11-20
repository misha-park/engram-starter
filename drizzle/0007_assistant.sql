CREATE TABLE `assistant_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	`conversation_id` text,
	`request` text NOT NULL,
	`status` text NOT NULL,
	`change_count` integer DEFAULT 0 NOT NULL,
	`resolved_at` text
);

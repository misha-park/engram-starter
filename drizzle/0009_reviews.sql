CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`lecture_id` text NOT NULL,
	`step` integer NOT NULL,
	`due` text NOT NULL,
	`block_id` text,
	`rating` text,
	`done_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL,
	FOREIGN KEY (`lecture_id`) REFERENCES `lectures`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_lecture_step_idx` ON `reviews` (`lecture_id`,`step`);
CREATE TABLE `moodle_forum_posts` (
	`id` integer PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`forum_id` integer NOT NULL,
	`discussion_id` integer NOT NULL,
	`author_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`is_reply` integer DEFAULT false NOT NULL,
	`subject` text,
	`author` text,
	`text` text,
	`title` text,
	`url` text,
	`created` integer NOT NULL,
	`dismissed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `moodle_forums` (
	`id` integer PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`baseline` integer NOT NULL,
	`seen_until` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `moodle_people` (
	`course_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`staff` integer NOT NULL,
	PRIMARY KEY(`course_id`, `user_id`)
);
--> statement-breakpoint
ALTER TABLE `modules` ADD `forum_notifications` integer DEFAULT true NOT NULL;
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_task_seq` ON `events` (`task_id`,`seq`);--> statement-breakpoint
CREATE TABLE `queued_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`event_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent` text NOT NULL,
	`role` text NOT NULL,
	`sdk_thread_id` text,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`workflow` text NOT NULL,
	`status` text NOT NULL,
	`activity` text,
	`cwd` text,
	`workspace` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

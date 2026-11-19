CREATE TABLE `hosts` (
	`name` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`user` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`key_path` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`prod` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ssh_log` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`host` text NOT NULL,
	`command` text NOT NULL,
	`exit_code` integer,
	`output` text NOT NULL,
	`started_at` text NOT NULL,
	`duration_ms` integer NOT NULL
);

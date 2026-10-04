CREATE TABLE `thread_provider_configurations` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`desired` text NOT NULL,
	`delivered` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);

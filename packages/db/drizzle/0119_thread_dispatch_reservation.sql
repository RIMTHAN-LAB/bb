CREATE TABLE `thread_dispatch_reservations` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_dispatch_reservations_expiry_idx` ON `thread_dispatch_reservations` (`expires_at`);
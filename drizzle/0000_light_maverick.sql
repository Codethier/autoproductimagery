CREATE TABLE `systemPrompt` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`TextPrompt` text NOT NULL,
	`serverImages` text,
	`modelImages` text,
	`outputImage` text NOT NULL,
	`createdAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updatedAt` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

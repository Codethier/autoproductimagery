ALTER TABLE `systemPrompt` ADD `generationModel` text;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `inputTokens` integer;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `outputTokens` integer;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `totalTokens` integer;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `cachedInputTokens` integer;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `reasoningTokens` integer;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `priceUsd` text;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `gatewayGenerationId` text;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `usageJson` text;
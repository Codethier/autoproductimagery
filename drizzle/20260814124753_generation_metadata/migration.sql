ALTER TABLE `aiGatewayLog` ADD `batchId` text;--> statement-breakpoint
ALTER TABLE `aiGatewayLog` ADD `attemptNumber` integer;--> statement-breakpoint
ALTER TABLE `aiGatewayLog` ADD `providerRequestId` text;--> statement-breakpoint
ALTER TABLE `aiGatewayLog` ADD `resolvedConfigJson` text;--> statement-breakpoint
ALTER TABLE `aiGatewayLog` ADD `errorJson` text;--> statement-breakpoint
CREATE INDEX `aiGatewayLog_systemPromptId_idx` ON `aiGatewayLog` (`systemPromptId`);--> statement-breakpoint
CREATE INDEX `aiGatewayLog_batchId_idx` ON `aiGatewayLog` (`batchId`);--> statement-breakpoint
CREATE INDEX `aiGatewayLog_gatewayGenerationId_idx` ON `aiGatewayLog` (`gatewayGenerationId`);--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `status` text;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `batchId` text;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `parentSystemPromptId` integer;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `generationConfig` text;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `outputMetadata` text;--> statement-breakpoint
ALTER TABLE `systemPrompt` ADD `errorJson` text;--> statement-breakpoint
CREATE INDEX `systemPrompt_batchId_idx` ON `systemPrompt` (`batchId`);--> statement-breakpoint
CREATE INDEX `systemPrompt_parentSystemPromptId_idx` ON `systemPrompt` (`parentSystemPromptId`);
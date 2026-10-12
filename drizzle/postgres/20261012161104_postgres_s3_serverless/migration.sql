CREATE TABLE "aiGatewayLog" (
	"id" serial PRIMARY KEY,
	"systemPromptId" integer,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"inputImages" jsonb,
	"modelImages" jsonb,
	"outputImage" text,
	"outputMimeType" text,
	"inputTokens" integer,
	"outputTokens" integer,
	"totalTokens" integer,
	"priceUsd" text,
	"priceSource" text,
	"gatewayGenerationId" text,
	"requestJson" jsonb,
	"responseJson" jsonb,
	"error" text,
	"durationMs" integer,
	"batchId" text,
	"attemptNumber" integer,
	"providerRequestId" text,
	"resolvedConfigJson" jsonb,
	"errorJson" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempt" (
	"key" text PRIMARY KEY,
	"attempts" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_lease" (
	"id" uuid PRIMARY KEY,
	"scope" text NOT NULL,
	"owner" uuid NOT NULL,
	"state" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "systemPrompt" (
	"id" serial PRIMARY KEY,
	"TextPrompt" text NOT NULL,
	"serverImages" jsonb,
	"modelImages" jsonb,
	"outputImage" text NOT NULL,
	"generationModel" text,
	"inputTokens" integer,
	"outputTokens" integer,
	"totalTokens" integer,
	"cachedInputTokens" integer,
	"reasoningTokens" integer,
	"priceUsd" text,
	"priceSource" text,
	"gatewayGenerationId" text,
	"usageJson" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"errors" text,
	"status" text,
	"batchId" text,
	"parentSystemPromptId" integer,
	"generationConfig" jsonb,
	"outputMetadata" jsonb,
	"errorJson" jsonb
);
--> statement-breakpoint
CREATE INDEX "aiGatewayLog_systemPromptId_idx" ON "aiGatewayLog" ("systemPromptId");--> statement-breakpoint
CREATE INDEX "aiGatewayLog_batchId_idx" ON "aiGatewayLog" ("batchId");--> statement-breakpoint
CREATE INDEX "aiGatewayLog_gatewayGenerationId_idx" ON "aiGatewayLog" ("gatewayGenerationId");--> statement-breakpoint
CREATE INDEX "login_attempt_reset_idx" ON "login_attempt" ("reset_at");--> statement-breakpoint
CREATE INDEX "runtime_lease_scope_state_expires_idx" ON "runtime_lease" ("scope","state","expires_at");--> statement-breakpoint
CREATE INDEX "runtime_lease_owner_expires_idx" ON "runtime_lease" ("owner","expires_at");--> statement-breakpoint
CREATE INDEX "systemPrompt_batchId_idx" ON "systemPrompt" ("batchId");--> statement-breakpoint
CREATE INDEX "systemPrompt_parentSystemPromptId_idx" ON "systemPrompt" ("parentSystemPromptId");--> statement-breakpoint
CREATE INDEX "systemPrompt_status_updatedAt_idx" ON "systemPrompt" ("status","updatedAt");
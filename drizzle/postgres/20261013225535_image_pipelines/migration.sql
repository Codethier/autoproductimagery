CREATE TABLE "pipeline_run_item" (
	"id" uuid PRIMARY KEY,
	"run_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"input_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_run_step" (
	"id" uuid PRIMARY KEY,
	"run_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"type" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"value" jsonb,
	"error" jsonb,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"provider_started_at" timestamp with time zone,
	"batch_id" uuid,
	"background_removal_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "pipeline_step_status_check" CHECK ("status" IN ('queued','running','awaiting-price','succeeded','failed','skipped','interrupted','cancelled')),
	CONSTRAINT "pipeline_step_attempt_check" CHECK ("attempt" BETWEEN 1 AND 5),
	CONSTRAINT "pipeline_step_claim_check" CHECK (("status" = 'running' AND "claim_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL) OR ("status" <> 'running' AND "claim_token" IS NULL AND "lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "pipeline_run" (
	"id" uuid PRIMARY KEY,
	"pipeline_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"batch_input_node_id" text,
	"target_node_id" text,
	"idempotency_key" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "pipeline_run_status_check" CHECK ("status" IN ('queued','running','awaiting-price','succeeded','partial','failed','cancelled','interrupted'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_step_output" (
	"id" uuid PRIMARY KEY,
	"step_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"output_asset_id" uuid NOT NULL,
	"output_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pipeline" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_name_check" CHECK (length(trim("name")) BETWEEN 1 AND 100),
	CONSTRAINT "pipeline_description_check" CHECK (length("description") <= 4000),
	CONSTRAINT "pipeline_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD COLUMN "pipelineStepId" uuid;--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD COLUMN "pipelineTextConfig" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_run_item_index_unique" ON "pipeline_run_item" ("run_id","index");--> statement-breakpoint
CREATE INDEX "pipeline_run_item_owner_idx" ON "pipeline_run_item" ("organization_id","user_id","run_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_step_active_unique" ON "pipeline_run_step" ("item_id","node_id") WHERE "active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_step_attempt_unique" ON "pipeline_run_step" ("item_id","node_id","attempt");--> statement-breakpoint
CREATE INDEX "pipeline_step_owner_run_idx" ON "pipeline_run_step" ("organization_id","user_id","run_id","active");--> statement-breakpoint
CREATE INDEX "pipeline_step_expired_idx" ON "pipeline_run_step" ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_run_idempotency_unique" ON "pipeline_run" ("organization_id","user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "pipeline_run_worker_due_idx" ON "pipeline_run" ("status","next_attempt_at","updated_at");--> statement-breakpoint
CREATE INDEX "pipeline_run_owner_history_idx" ON "pipeline_run" ("organization_id","user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_step_output_asset_unique" ON "pipeline_step_output" ("output_asset_id");--> statement-breakpoint
CREATE INDEX "pipeline_step_output_url_idx" ON "pipeline_step_output" ("output_url");--> statement-breakpoint
CREATE INDEX "pipeline_step_output_retention_idx" ON "pipeline_step_output" ("created_at","id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pipeline_owner_history_idx" ON "pipeline" ("organization_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "systemPrompt_pipeline_step_idx" ON "systemPrompt" ("pipelineStepId","organizationId","userId");--> statement-breakpoint
ALTER TABLE "pipeline_run_item" ADD CONSTRAINT "pipeline_run_item_run_id_pipeline_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "pipeline_run"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run_item" ADD CONSTRAINT "pipeline_run_item_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run_item" ADD CONSTRAINT "pipeline_run_item_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run_step" ADD CONSTRAINT "pipeline_run_step_run_id_pipeline_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "pipeline_run"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run_step" ADD CONSTRAINT "pipeline_run_step_item_id_pipeline_run_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "pipeline_run_item"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run_step" ADD CONSTRAINT "pipeline_run_step_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run_step" ADD CONSTRAINT "pipeline_run_step_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run_step" ADD CONSTRAINT "pipeline_run_step_219qF43942On_fkey" FOREIGN KEY ("background_removal_job_id") REFERENCES "background_removal_job"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_pipeline_id_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipeline"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "pipeline_step_output" ADD CONSTRAINT "pipeline_step_output_step_id_pipeline_run_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "pipeline_run_step"("id");--> statement-breakpoint
ALTER TABLE "pipeline_step_output" ADD CONSTRAINT "pipeline_step_output_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "pipeline_step_output" ADD CONSTRAINT "pipeline_step_output_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "pipeline_step_output" ADD CONSTRAINT "pipeline_step_output_output_asset_id_asset_id_fkey" FOREIGN KEY ("output_asset_id") REFERENCES "asset"("id");--> statement-breakpoint
ALTER TABLE "pipeline" ADD CONSTRAINT "pipeline_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "pipeline" ADD CONSTRAINT "pipeline_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD CONSTRAINT "systemPrompt_pipelineStepId_pipeline_run_step_id_fkey" FOREIGN KEY ("pipelineStepId") REFERENCES "pipeline_run_step"("id") ON DELETE SET NULL;
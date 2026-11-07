CREATE TABLE "background_removal_job" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source_asset_id" uuid NOT NULL,
	"source_url" text NOT NULL,
	"model" text NOT NULL,
	"model_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"output_asset_id" uuid,
	"output_url" text,
	"provider_price_usd" text DEFAULT '0' NOT NULL,
	"error_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "background_removal_model_check" CHECK ("model" IN ('birefnet-lite', 'birefnet')),
	CONSTRAINT "background_removal_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "background_removal_attempts_check" CHECK ("attempts" BETWEEN 0 AND 2),
	CONSTRAINT "background_removal_provider_price_check" CHECK ("provider_price_usd" = '0'),
	CONSTRAINT "background_removal_lease_check" CHECK (("status" = 'running' AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL) OR ("status" <> 'running' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL)),
	CONSTRAINT "background_removal_output_check" CHECK (("status" = 'succeeded' AND "output_asset_id" IS NOT NULL AND "output_url" IS NOT NULL) OR ("status" <> 'succeeded' AND "output_asset_id" IS NULL AND "output_url" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "background_removal_idempotency_unique" ON "background_removal_job" ("organization_id","user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "background_removal_owner_history_idx" ON "background_removal_job" ("organization_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "background_removal_queue_idx" ON "background_removal_job" ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "background_removal_lease_idx" ON "background_removal_job" ("status","lease_expires_at");--> statement-breakpoint
ALTER TABLE "background_removal_job" ADD CONSTRAINT "background_removal_job_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "background_removal_job" ADD CONSTRAINT "background_removal_job_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "background_removal_job" ADD CONSTRAINT "background_removal_job_source_asset_id_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "asset"("id");--> statement-breakpoint
ALTER TABLE "background_removal_job" ADD CONSTRAINT "background_removal_job_output_asset_id_asset_id_fkey" FOREIGN KEY ("output_asset_id") REFERENCES "asset"("id");--> statement-breakpoint
ALTER TABLE "asset" DROP CONSTRAINT "asset_category_check", ADD CONSTRAINT "asset_category_check" CHECK ("category" IN ('uploaded', 'generated', 'processed'));
CREATE TABLE "account_balance_adjustment" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"adjusted_by_user_id" uuid NOT NULL,
	"previous_units" numeric(30,0),
	"actual_units" numeric(30,0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_generation_charge" (
	"generation_id" integer PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" text DEFAULT 'outstanding' NOT NULL,
	"estimated_units" numeric(30,0),
	"confirmed_units" numeric(30,0),
	"gateway_generation_id" text,
	"confirmed_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_charge_state_check" CHECK ("state" IN ('outstanding', 'confirmed', 'released')),
	CONSTRAINT "account_charge_amount_check" CHECK (("estimated_units" IS NULL OR "estimated_units" >= 0) AND ("confirmed_units" IS NULL OR "confirmed_units" >= 0)),
	CONSTRAINT "account_charge_confirmation_check" CHECK (("state" = 'confirmed') = ("confirmed_units" IS NOT NULL AND "confirmed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD COLUMN "billingState" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "credit_balance_units" numeric(30,0);--> statement-breakpoint
CREATE INDEX "account_balance_adjustment_owner_idx" ON "account_balance_adjustment" ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_charge_owner_state_idx" ON "account_generation_charge" ("organization_id","user_id","state","next_check_at");--> statement-breakpoint
CREATE INDEX "account_charge_gateway_idx" ON "account_generation_charge" ("organization_id","user_id","gateway_generation_id");--> statement-breakpoint
ALTER TABLE "account_balance_adjustment" ADD CONSTRAINT "account_balance_adjustment_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "account_balance_adjustment" ADD CONSTRAINT "account_balance_adjustment_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "account_balance_adjustment" ADD CONSTRAINT "account_balance_adjustment_adjusted_by_user_id_app_user_id_fkey" FOREIGN KEY ("adjusted_by_user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "account_generation_charge" ADD CONSTRAINT "account_generation_charge_generation_id_systemPrompt_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "systemPrompt"("id");--> statement-breakpoint
ALTER TABLE "account_generation_charge" ADD CONSTRAINT "account_generation_charge_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "account_generation_charge" ADD CONSTRAINT "account_generation_charge_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");
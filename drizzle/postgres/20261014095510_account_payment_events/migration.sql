CREATE TABLE "account_payment" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_by_display_name" text NOT NULL,
	"recorded_by_username" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"amount_units" numeric(30,0) NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_payment_amount_check" CHECK ("amount_units" > 0 AND "amount_units" <= 1000000000000000000 AND mod("amount_units", 10000000000) = 0),
	CONSTRAINT "account_payment_note_check" CHECK (length("note") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_payment_idempotency_unique" ON "account_payment" ("organization_id","user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "account_payment_user_history_idx" ON "account_payment" ("organization_id","user_id","created_at","id");--> statement-breakpoint
ALTER TABLE "account_payment" ADD CONSTRAINT "account_payment_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "account_payment" ADD CONSTRAINT "account_payment_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "account_payment" ADD CONSTRAINT "account_payment_recorded_by_user_id_app_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "app_user"("id");
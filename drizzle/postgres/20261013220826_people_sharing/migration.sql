CREATE TABLE "person_share" (
	"id" uuid PRIMARY KEY,
	"person_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"shared_by_user_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "person_share_recipient_unique" ON "person_share" ("person_id","recipient_user_id");--> statement-breakpoint
CREATE INDEX "person_share_org_recipient_idx" ON "person_share" ("organization_id","recipient_user_id","person_id");--> statement-breakpoint
ALTER TABLE "person_share" ADD CONSTRAINT "person_share_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "person_share" ADD CONSTRAINT "person_share_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "person_share" ADD CONSTRAINT "person_share_shared_by_user_id_app_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "person_share" ADD CONSTRAINT "person_share_recipient_user_id_app_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "app_user"("id");
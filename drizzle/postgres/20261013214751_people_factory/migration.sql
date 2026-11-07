CREATE TABLE "person" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_name_check" CHECK (length(trim("name")) BETWEEN 1 AND 80),
	CONSTRAINT "person_description_check" CHECK (length("description") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "person_photo" (
	"id" uuid PRIMARY KEY,
	"person_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD COLUMN "personId" uuid;--> statement-breakpoint
CREATE INDEX "person_owner_idx" ON "person" ("organization_id","user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_photo_asset_unique" ON "person_photo" ("person_id","asset_id");--> statement-breakpoint
CREATE INDEX "person_photo_asset_idx" ON "person_photo" ("asset_id");--> statement-breakpoint
CREATE INDEX "systemPrompt_person_idx" ON "systemPrompt" ("personId","organizationId","userId","id");--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "person_photo" ADD CONSTRAINT "person_photo_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "person_photo" ADD CONSTRAINT "person_photo_asset_id_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD CONSTRAINT "systemPrompt_personId_person_id_fkey" FOREIGN KEY ("personId") REFERENCES "person"("id") ON DELETE SET NULL;
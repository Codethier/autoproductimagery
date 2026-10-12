CREATE TABLE "account_session" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"auth_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_share" (
	"id" uuid PRIMARY KEY,
	"asset_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"shared_by_user_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_share_permission_check" CHECK ("permission" IN ('view', 'edit'))
);
--> statement-breakpoint
CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"category" text DEFAULT 'uploaded' NOT NULL,
	"byte_size" bigint,
	"mime_type" text,
	"width" integer,
	"height" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_kind_check" CHECK ("kind" IN ('file', 'folder')),
	CONSTRAINT "asset_category_check" CHECK ("category" IN ('uploaded', 'generated'))
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"is_bootstrap" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"username" text NOT NULL,
	"normalized_username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"is_bootstrap_owner" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"auth_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_role_check" CHECK ("role" IN ('owner', 'user'))
);
--> statement-breakpoint
ALTER TABLE "aiGatewayLog" ADD COLUMN "organizationId" uuid;--> statement-breakpoint
ALTER TABLE "aiGatewayLog" ADD COLUMN "userId" uuid;--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD COLUMN "organizationId" uuid;--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD COLUMN "userId" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "account_session_token_unique" ON "account_session" ("token_hash");--> statement-breakpoint
CREATE INDEX "account_session_user_idx" ON "account_session" ("user_id");--> statement-breakpoint
CREATE INDEX "account_session_expiry_idx" ON "account_session" ("expires_at");--> statement-breakpoint
CREATE INDEX "aiGatewayLog_user_history_idx" ON "aiGatewayLog" ("organizationId","userId","createdAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_share_recipient_unique" ON "asset_share" ("asset_id","recipient_user_id");--> statement-breakpoint
CREATE INDEX "asset_share_org_recipient_idx" ON "asset_share" ("organization_id","recipient_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_url_unique" ON "asset" ("url") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "asset_owner_parent_idx" ON "asset" ("organization_id","owner_user_id","parent_id","name");--> statement-breakpoint
CREATE INDEX "asset_parent_idx" ON "asset" ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_bootstrap_unique" ON "organization" ("is_bootstrap") WHERE "is_bootstrap" = true;--> statement-breakpoint
CREATE INDEX "systemPrompt_user_history_idx" ON "systemPrompt" ("organizationId","userId","createdAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_username_unique" ON "app_user" ("normalized_username");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_bootstrap_unique" ON "app_user" ("is_bootstrap_owner") WHERE "is_bootstrap_owner" = true;--> statement-breakpoint
CREATE INDEX "app_user_organization_idx" ON "app_user" ("organization_id","created_at","id");--> statement-breakpoint
ALTER TABLE "account_session" ADD CONSTRAINT "account_session_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "aiGatewayLog" ADD CONSTRAINT "aiGatewayLog_organizationId_organization_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "aiGatewayLog" ADD CONSTRAINT "aiGatewayLog_userId_app_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "asset_share" ADD CONSTRAINT "asset_share_asset_id_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "asset_share" ADD CONSTRAINT "asset_share_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "asset_share" ADD CONSTRAINT "asset_share_shared_by_user_id_app_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "asset_share" ADD CONSTRAINT "asset_share_recipient_user_id_app_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_owner_user_id_app_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_created_by_user_id_app_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_parent_id_asset_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "asset"("id");--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD CONSTRAINT "systemPrompt_organizationId_organization_id_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "systemPrompt" ADD CONSTRAINT "systemPrompt_userId_app_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id");
CREATE TABLE "resumable_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id_hash" text NOT NULL,
	"parent_key_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_owner_clerk_user_id" text NOT NULL,
	"target_email" text,
	"recipient_verdict" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "resumable_uploads_upload_id_hash_unique" UNIQUE("upload_id_hash")
);
--> statement-breakpoint
CREATE TABLE "temporary_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_hash" text NOT NULL,
	"key_last4" text NOT NULL,
	"parent_key_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "temporary_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "resumable_uploads" ADD CONSTRAINT "resumable_uploads_parent_key_id_proxy_keys_id_fk" FOREIGN KEY ("parent_key_id") REFERENCES "public"."proxy_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_api_keys" ADD CONSTRAINT "temporary_api_keys_parent_key_id_proxy_keys_id_fk" FOREIGN KEY ("parent_key_id") REFERENCES "public"."proxy_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_api_keys" ADD CONSTRAINT "temporary_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_api_keys" ADD CONSTRAINT "temporary_api_keys_connection_id_agent_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "temporary_api_keys_connection_idx" ON "temporary_api_keys" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "temporary_api_keys_parent_idx" ON "temporary_api_keys" USING btree ("parent_key_id");
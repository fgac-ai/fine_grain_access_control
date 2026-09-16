CREATE TABLE "account_refusals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proxy_key_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_email" text NOT NULL,
	"refusal_count" integer DEFAULT 1 NOT NULL,
	"window_started_at" timestamp DEFAULT now() NOT NULL,
	"window_count" integer DEFAULT 1 NOT NULL,
	"first_refused_at" timestamp DEFAULT now() NOT NULL,
	"last_refused_at" timestamp DEFAULT now() NOT NULL,
	"last_tool" text,
	"notified_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "notified_at" timestamp;--> statement-breakpoint
ALTER TABLE "account_refusals" ADD CONSTRAINT "account_refusals_proxy_key_id_proxy_keys_id_fk" FOREIGN KEY ("proxy_key_id") REFERENCES "public"."proxy_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_refusals" ADD CONSTRAINT "account_refusals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_refusals_key_email_unique" ON "account_refusals" USING btree ("proxy_key_id","requested_email");--> statement-breakpoint
CREATE INDEX "account_refusals_user_notified_idx" ON "account_refusals" USING btree ("user_id","notified_at");--> statement-breakpoint
CREATE INDEX "approval_requests_user_notified_idx" ON "approval_requests" USING btree ("user_id","notified_at");
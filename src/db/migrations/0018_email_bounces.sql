CREATE TABLE "email_bounces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"bounce_class" text NOT NULL,
	"dsn_status" text NOT NULL,
	"dsn_diagnostic" text,
	"notice_kind" text DEFAULT 'unknown' NOT NULL,
	"user_id" uuid,
	"gmail_message_id" text NOT NULL,
	"bounced_at" timestamp NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_grant_failures" ADD COLUMN "undeliverable_at" timestamp;--> statement-breakpoint
ALTER TABLE "google_grant_failures" ADD COLUMN "undeliverable_class" text;--> statement-breakpoint
ALTER TABLE "google_grant_failures" ADD COLUMN "undeliverable_status" text;--> statement-breakpoint
ALTER TABLE "email_bounces" ADD CONSTRAINT "email_bounces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_bounces_message_unique" ON "email_bounces" USING btree ("gmail_message_id");--> statement-breakpoint
CREATE INDEX "email_bounces_address_idx" ON "email_bounces" USING btree ("address");
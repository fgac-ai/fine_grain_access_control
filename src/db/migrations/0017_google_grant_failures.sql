CREATE TABLE "google_grant_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_email" text NOT NULL,
	"last_reason" text NOT NULL,
	"first_failed_at" timestamp DEFAULT now() NOT NULL,
	"last_failed_at" timestamp DEFAULT now() NOT NULL,
	"failure_count" integer DEFAULT 1 NOT NULL,
	"notified_count" integer DEFAULT 0 NOT NULL,
	"notified_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "google_grant_failures" ADD CONSTRAINT "google_grant_failures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_grant_failures_owner_email_unique" ON "google_grant_failures" USING btree ("user_id","account_email");--> statement-breakpoint
CREATE INDEX "google_grant_failures_user_notified_idx" ON "google_grant_failures" USING btree ("user_id","notified_at");
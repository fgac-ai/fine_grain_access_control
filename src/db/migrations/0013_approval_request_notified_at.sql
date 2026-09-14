ALTER TABLE "approval_requests" ADD COLUMN "notified_at" timestamp;--> statement-breakpoint
CREATE INDEX "approval_requests_user_notified_idx" ON "approval_requests" USING btree ("user_id","notified_at");

ALTER TABLE "resumable_uploads" ADD COLUMN "google_session_url" text NOT NULL;--> statement-breakpoint
ALTER TABLE "resumable_uploads" ADD COLUMN "file_id" text;
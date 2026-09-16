ALTER TABLE "approval_requests" ADD COLUMN "wall_hit_at" timestamp;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "wall_query" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "routed_at" timestamp;
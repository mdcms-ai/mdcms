ALTER TABLE "document_versions" ALTER COLUMN "published_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "created_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "updated_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "published_origin" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "created_origin" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "updated_origin" jsonb;
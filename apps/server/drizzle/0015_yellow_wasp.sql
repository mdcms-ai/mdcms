CREATE TABLE "project_media_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"image_max_upload_size_bytes" bigint,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_media_settings_image_max_size_positive" CHECK ("project_media_settings"."image_max_upload_size_bytes" is null or "project_media_settings"."image_max_upload_size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "media" ALTER COLUMN "uploaded_by" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "project_media_settings" ADD CONSTRAINT "project_media_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
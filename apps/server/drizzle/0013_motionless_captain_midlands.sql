CREATE TABLE "webhook_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event" text NOT NULL,
	"event_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"url" text NOT NULL,
	"attempt" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"outcome" text NOT NULL,
	"status_code" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_delivery_attempts_attempt_check" CHECK ("webhook_delivery_attempts"."attempt" > 0),
	CONSTRAINT "webhook_delivery_attempts_max_attempts_check" CHECK ("webhook_delivery_attempts"."max_attempts" > 0),
	CONSTRAINT "webhook_delivery_attempts_attempt_le_max_attempts_check" CHECK ("webhook_delivery_attempts"."attempt" <= "webhook_delivery_attempts"."max_attempts"),
	CONSTRAINT "webhook_delivery_attempts_outcome_check" CHECK ("webhook_delivery_attempts"."outcome" in ('succeeded', 'retrying', 'failed', 'discarded')),
	CONSTRAINT "webhook_delivery_attempts_status_code_check" CHECK ("webhook_delivery_attempts"."status_code" is null or ("webhook_delivery_attempts"."status_code" >= 100 and "webhook_delivery_attempts"."status_code" <= 599))
);
--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "fk_webhook_delivery_attempts_env_project" FOREIGN KEY ("environment_id","project_id") REFERENCES "public"."environments"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_webhook_delivery_attempts_scope" ON "webhook_delivery_attempts" USING btree ("project_id","environment_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_webhook_delivery_attempts_filters" ON "webhook_delivery_attempts" USING btree ("project_id","environment_id","webhook_id","event","outcome","created_at" DESC NULLS LAST);

CREATE TABLE "published_search_index" (
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"schema_type" text NOT NULL,
	"search_config" regconfig NOT NULL,
	"search_vector" tsvector NOT NULL,
	CONSTRAINT "published_search_index_pkey" PRIMARY KEY("project_id","environment_id","document_id","locale")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "unique_document_scope" UNIQUE("document_id","project_id","environment_id");--> statement-breakpoint
ALTER TABLE "published_search_index" ADD CONSTRAINT "published_search_index_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_search_index" ADD CONSTRAINT "published_search_index_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_search_index" ADD CONSTRAINT "fk_published_search_index_document" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_search_index" ADD CONSTRAINT "fk_published_search_index_document_scope" FOREIGN KEY ("document_id","project_id","environment_id") REFERENCES "public"."documents"("document_id","project_id","environment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_search_index" ADD CONSTRAINT "fk_published_search_index_env_project" FOREIGN KEY ("environment_id","project_id") REFERENCES "public"."environments"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_published_search_vector" ON "published_search_index" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "idx_published_search_scope_type_locale" ON "published_search_index" USING btree ("project_id","environment_id","schema_type","locale");--> statement-breakpoint
INSERT INTO "published_search_index" (
  "project_id",
  "environment_id",
  "document_id",
  "locale",
  "schema_type",
  "search_config",
  "search_vector"
)
SELECT
  "documents"."project_id",
  "documents"."environment_id",
  "document_versions"."document_id",
  "document_versions"."locale",
  "document_versions"."schema_type",
  CASE lower(split_part("document_versions"."locale", '-', 1))
    WHEN 'da' THEN 'danish'::regconfig
    WHEN 'de' THEN 'german'::regconfig
    WHEN 'en' THEN 'english'::regconfig
    WHEN 'es' THEN 'spanish'::regconfig
    WHEN 'fi' THEN 'finnish'::regconfig
    WHEN 'fr' THEN 'french'::regconfig
    WHEN 'hu' THEN 'hungarian'::regconfig
    WHEN 'it' THEN 'italian'::regconfig
    WHEN 'nl' THEN 'dutch'::regconfig
    WHEN 'no' THEN 'norwegian'::regconfig
    WHEN 'nb' THEN 'norwegian'::regconfig
    WHEN 'nn' THEN 'norwegian'::regconfig
    WHEN 'pt' THEN 'portuguese'::regconfig
    WHEN 'ro' THEN 'romanian'::regconfig
    WHEN 'ru' THEN 'russian'::regconfig
    WHEN 'sv' THEN 'swedish'::regconfig
    WHEN 'tr' THEN 'turkish'::regconfig
    ELSE 'simple'::regconfig
  END AS "search_config",
  to_tsvector(
    CASE lower(split_part("document_versions"."locale", '-', 1))
      WHEN 'da' THEN 'danish'::regconfig
      WHEN 'de' THEN 'german'::regconfig
      WHEN 'en' THEN 'english'::regconfig
      WHEN 'es' THEN 'spanish'::regconfig
      WHEN 'fi' THEN 'finnish'::regconfig
      WHEN 'fr' THEN 'french'::regconfig
      WHEN 'hu' THEN 'hungarian'::regconfig
      WHEN 'it' THEN 'italian'::regconfig
      WHEN 'nl' THEN 'dutch'::regconfig
      WHEN 'no' THEN 'norwegian'::regconfig
      WHEN 'nb' THEN 'norwegian'::regconfig
      WHEN 'nn' THEN 'norwegian'::regconfig
      WHEN 'pt' THEN 'portuguese'::regconfig
      WHEN 'ro' THEN 'romanian'::regconfig
      WHEN 'ru' THEN 'russian'::regconfig
      WHEN 'sv' THEN 'swedish'::regconfig
      WHEN 'tr' THEN 'turkish'::regconfig
      ELSE 'simple'::regconfig
    END,
    concat_ws(
      E'\n',
      "document_versions"."path",
      "document_versions"."body",
      "document_versions"."frontmatter"::text
    )
  ) AS "search_vector"
FROM "documents"
INNER JOIN "document_versions"
  ON "document_versions"."document_id" = "documents"."document_id"
  AND "document_versions"."version" = "documents"."published_version"
WHERE "documents"."is_deleted" = false
  AND "documents"."published_version" IS NOT NULL
ON CONFLICT (
  "project_id",
  "environment_id",
  "document_id",
  "locale"
) DO UPDATE SET
  "schema_type" = excluded."schema_type",
  "search_config" = excluded."search_config",
  "search_vector" = excluded."search_vector";

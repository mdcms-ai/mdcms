import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";

type DrizzleJournal = {
  entries: Array<{
    idx: number;
    tag: string;
  }>;
};

type SnapshotIndex = {
  columns?: Array<{
    expression?: string;
  }>;
  isUnique?: boolean;
  method?: string;
};

type SnapshotKey = {
  columns?: string[];
  name?: string;
  nullsNotDistinct?: boolean;
};

type DrizzleSnapshot = {
  tables: Record<
    string,
    {
      columns: Record<
        string,
        {
          default?: string;
          notNull?: boolean;
          primaryKey?: boolean;
          type?: string;
        }
      >;
      indexes: Record<string, SnapshotIndex>;
      foreignKeys: Record<
        string,
        {
          columnsFrom?: string[];
          columnsTo?: string[];
          onDelete?: string;
          onUpdate?: string;
          tableFrom?: string;
          tableTo?: string;
        }
      >;
      compositePrimaryKeys: Record<string, SnapshotKey>;
      uniqueConstraints: Record<string, SnapshotKey>;
      checkConstraints: Record<string, { value?: string }>;
    }
  >;
};

function indexColumnExpressions(index: SnapshotIndex): string[] {
  return index.columns?.map((column) => column.expression ?? "") ?? [];
}

function readLatestArtifacts(): {
  allMigrationSql: string;
  snapshot: DrizzleSnapshot;
} {
  const drizzleDirectory = resolve(import.meta.dirname, "../../../drizzle");
  const metaDirectory = resolve(drizzleDirectory, "meta");
  const journalPath = resolve(metaDirectory, "_journal.json");
  const journal = JSON.parse(
    readFileSync(journalPath, "utf8"),
  ) as DrizzleJournal;
  const latestEntry = [...journal.entries].sort(
    (left, right) => right.idx - left.idx,
  )[0];

  assert.ok(latestEntry, "expected drizzle journal to have at least one entry");

  const snapshotPath = resolve(
    metaDirectory,
    `${String(latestEntry.idx).padStart(4, "0")}_snapshot.json`,
  );
  const allMigrationSql = [...journal.entries]
    .sort((left, right) => left.idx - right.idx)
    .map((entry) =>
      readFileSync(resolve(drizzleDirectory, `${entry.tag}.sql`), "utf8"),
    )
    .join("\n");

  const snapshot = JSON.parse(
    readFileSync(snapshotPath, "utf8"),
  ) as DrizzleSnapshot;

  return {
    allMigrationSql,
    snapshot,
  };
}

test("schema snapshot includes CMS-11/CMS-12 core tables and columns", () => {
  const { snapshot } = readLatestArtifacts();

  const requiredTableColumns: Record<string, string[]> = {
    "public.users": [
      "id",
      "name",
      "email",
      "email_verified",
      "image",
      "created_at",
      "updated_at",
    ],
    "public.sessions": [
      "id",
      "expires_at",
      "token",
      "created_at",
      "updated_at",
      "ip_address",
      "user_agent",
      "user_id",
    ],
    "public.accounts": [
      "id",
      "account_id",
      "provider_id",
      "user_id",
      "access_token",
      "refresh_token",
      "id_token",
      "access_token_expires_at",
      "refresh_token_expires_at",
      "scope",
      "password",
      "created_at",
      "updated_at",
    ],
    "public.verifications": [
      "id",
      "identifier",
      "value",
      "expires_at",
      "created_at",
      "updated_at",
    ],
    "public.api_keys": [
      "id",
      "label",
      "key_prefix",
      "key_hash",
      "scopes",
      "context_allowlist",
      "expires_at",
      "revoked_at",
      "last_used_at",
      "created_by_user_id",
      "created_at",
    ],
    "public.cli_login_challenges": [
      "id",
      "project",
      "environment",
      "redirect_uri",
      "requested_scopes",
      "state_hash",
      "authorization_code_hash",
      "status",
      "user_id",
      "expires_at",
      "authorized_at",
      "used_at",
      "created_at",
    ],
    "public.auth_login_backoffs": [
      "id",
      "login_key",
      "failure_count",
      "first_failed_at",
      "last_failed_at",
      "next_allowed_at",
      "created_at",
      "updated_at",
    ],
    "public.rbac_grants": [
      "id",
      "user_id",
      "role",
      "scope_kind",
      "project",
      "environment",
      "path_prefix",
      "source",
      "created_by_user_id",
      "created_at",
      "revoked_at",
    ],
    "public.projects": [
      "id",
      "organization_id",
      "name",
      "slug",
      "created_at",
      "created_by",
    ],
    "public.environments": [
      "id",
      "project_id",
      "name",
      "description",
      "created_at",
      "created_by",
    ],
    "public.documents": [
      "document_id",
      "translation_group_id",
      "project_id",
      "environment_id",
      "path",
      "schema_type",
      "locale",
      "content_format",
      "body",
      "frontmatter",
      "is_deleted",
      "has_unpublished_changes",
      "published_version",
      "draft_revision",
      "created_by",
      "created_at",
      "updated_by",
      "updated_at",
    ],
    "public.document_versions": [
      "id",
      "document_id",
      "translation_group_id",
      "project_id",
      "environment_id",
      "schema_type",
      "locale",
      "content_format",
      "path",
      "body",
      "frontmatter",
      "version",
      "published_by",
      "published_at",
      "change_summary",
    ],
    "public.published_search_index": [
      "project_id",
      "environment_id",
      "document_id",
      "locale",
      "schema_type",
      "search_config",
      "search_vector",
    ],
    "public.media": [
      "id",
      "project_id",
      "filename",
      "mime_type",
      "size_bytes",
      "s3_key",
      "url",
      "uploaded_by",
      "uploaded_at",
    ],
    "public.project_media_settings": [
      "project_id",
      "image_max_upload_size_bytes",
      "updated_by",
      "created_at",
      "updated_at",
    ],
    "public.webhooks": [
      "id",
      "project_id",
      "environment_id",
      "url",
      "events",
      "secret",
      "active",
      "created_by",
      "updated_by",
      "created_at",
      "updated_at",
    ],
    "public.webhook_delivery_attempts": [
      "id",
      "project_id",
      "environment_id",
      "webhook_id",
      "event",
      "event_id",
      "delivery_id",
      "url",
      "attempt",
      "max_attempts",
      "outcome",
      "status_code",
      "error",
      "created_at",
    ],
    "public.migrations": [
      "id",
      "name",
      "project_id",
      "environment_id",
      "schema_type",
      "applied_at",
      "applied_by",
      "documents_affected",
    ],
    "public.schema_syncs": [
      "id",
      "project_id",
      "environment_id",
      "schema_hash",
      "raw_config_snapshot",
      "synced_at",
    ],
    "public.project_environment_topology_snapshots": [
      "id",
      "project",
      "config_snapshot_hash",
      "definitions",
      "synced_at",
    ],
    "public.schema_registry_entries": [
      "id",
      "project_id",
      "environment_id",
      "schema_type",
      "directory",
      "localized",
      "schema_hash",
      "resolved_schema",
      "synced_at",
    ],
  };

  assert.equal(
    snapshot.tables["public.media"]?.columns.uploaded_by?.type,
    "text",
    "expected public.media.uploaded_by to be text in snapshot",
  );
  assert.deepEqual(
    snapshot.tables["public.project_media_settings"]?.columns.project_id,
    {
      name: "project_id",
      type: "uuid",
      primaryKey: true,
      notNull: true,
    },
    "expected project_media_settings.project_id to be a non-null UUID primary key",
  );
  assert.deepEqual(
    snapshot.tables["public.project_media_settings"]?.columns
      .image_max_upload_size_bytes,
    {
      name: "image_max_upload_size_bytes",
      type: "bigint",
      primaryKey: false,
      notNull: false,
    },
    "expected project_media_settings.image_max_upload_size_bytes to be nullable BIGINT",
  );
  assert.deepEqual(
    snapshot.tables["public.project_media_settings"]?.columns.updated_by,
    {
      name: "updated_by",
      type: "text",
      primaryKey: false,
      notNull: true,
    },
    "expected project_media_settings.updated_by to be non-null text",
  );

  for (const columnName of ["created_at", "updated_at"] as const) {
    assert.deepEqual(
      snapshot.tables["public.project_media_settings"]?.columns[columnName],
      {
        name: columnName,
        type: "timestamp with time zone",
        primaryKey: false,
        notNull: true,
        default: "now()",
      },
      `expected project_media_settings.${columnName} to default to now()`,
    );
  }

  for (const [tableName, requiredColumns] of Object.entries(
    requiredTableColumns,
  )) {
    const table = snapshot.tables[tableName];
    assert.ok(table, `expected table ${tableName} to exist in snapshot`);

    for (const columnName of requiredColumns) {
      assert.ok(
        table.columns[columnName],
        `expected column ${tableName}.${columnName} to exist in snapshot`,
      );
    }
  }
});

test("snapshot includes required named constraints and indexes", () => {
  const { snapshot } = readLatestArtifacts();
  const documentsTable = snapshot.tables["public.documents"];
  const documentVersionsTable = snapshot.tables["public.document_versions"];
  const environmentsTable = snapshot.tables["public.environments"];
  const apiKeysTable = snapshot.tables["public.api_keys"];
  const cliLoginChallengesTable =
    snapshot.tables["public.cli_login_challenges"];
  const authLoginBackoffsTable = snapshot.tables["public.auth_login_backoffs"];
  const rbacGrantsTable = snapshot.tables["public.rbac_grants"];
  const authUsersTable = snapshot.tables["public.users"];
  const authSessionsTable = snapshot.tables["public.sessions"];
  const authAccountsTable = snapshot.tables["public.accounts"];
  const authVerificationsTable = snapshot.tables["public.verifications"];
  const schemaSyncsTable = snapshot.tables["public.schema_syncs"];
  const webhooksTable = snapshot.tables["public.webhooks"];
  const webhookDeliveryAttemptsTable =
    snapshot.tables["public.webhook_delivery_attempts"];
  const projectEnvironmentTopologySnapshotsTable =
    snapshot.tables["public.project_environment_topology_snapshots"];
  const schemaRegistryEntriesTable =
    snapshot.tables["public.schema_registry_entries"];
  const projectMediaSettingsTable =
    snapshot.tables["public.project_media_settings"];
  const publishedSearchIndexTable =
    snapshot.tables["public.published_search_index"];

  assert.ok(documentsTable, "expected documents table in snapshot");
  assert.ok(
    documentVersionsTable,
    "expected document_versions table in snapshot",
  );
  assert.ok(environmentsTable, "expected environments table in snapshot");
  assert.ok(apiKeysTable, "expected api_keys table in snapshot");
  assert.ok(
    cliLoginChallengesTable,
    "expected cli_login_challenges table in snapshot",
  );
  assert.ok(
    authLoginBackoffsTable,
    "expected auth_login_backoffs table in snapshot",
  );
  assert.ok(rbacGrantsTable, "expected rbac_grants table in snapshot");
  assert.ok(authUsersTable, "expected users table in snapshot");
  assert.ok(authSessionsTable, "expected sessions table in snapshot");
  assert.ok(authAccountsTable, "expected accounts table in snapshot");
  assert.ok(authVerificationsTable, "expected verifications table in snapshot");
  assert.ok(schemaSyncsTable, "expected schema_syncs table in snapshot");
  assert.ok(webhooksTable, "expected webhooks table in snapshot");
  assert.ok(
    webhookDeliveryAttemptsTable,
    "expected webhook_delivery_attempts table in snapshot",
  );
  assert.ok(
    projectEnvironmentTopologySnapshotsTable,
    "expected project_environment_topology_snapshots table in snapshot",
  );
  assert.ok(
    schemaRegistryEntriesTable,
    "expected schema_registry_entries table in snapshot",
  );
  assert.ok(
    projectMediaSettingsTable,
    "expected project_media_settings table in snapshot",
  );
  assert.ok(
    publishedSearchIndexTable,
    "expected published_search_index table in snapshot",
  );

  for (const indexName of [
    "idx_documents_active_scope_type_locale_path",
    "idx_documents_active_scope_updated_at",
    "idx_documents_active_scope_unpublished_updated_at",
    "idx_documents_scope_translation_group",
    "uniq_documents_active_path",
    "uniq_documents_active_translation_locale",
  ]) {
    assert.ok(
      documentsTable.indexes[indexName],
      `expected index ${indexName} on documents`,
    );
  }

  for (const foreignKeyName of [
    "fk_documents_env_project",
    "fk_documents_published_version",
  ]) {
    assert.ok(
      documentsTable.foreignKeys[foreignKeyName],
      `expected foreign key ${foreignKeyName} on documents`,
    );
  }
  assert.deepEqual(
    documentsTable.uniqueConstraints.unique_document_scope,
    {
      name: "unique_document_scope",
      nullsNotDistinct: false,
      columns: ["document_id", "project_id", "environment_id"],
    },
    "expected documents to expose document/project/environment scope for composite foreign keys",
  );

  for (const indexName of ["idx_versions_document", "idx_versions_scope"]) {
    assert.ok(
      documentVersionsTable.indexes[indexName],
      `expected index ${indexName} on document_versions`,
    );
  }

  assert.ok(
    documentVersionsTable.foreignKeys.fk_document_versions_env_project,
    "expected foreign key fk_document_versions_env_project on document_versions",
  );
  assert.ok(
    documentVersionsTable.uniqueConstraints.unique_document_version,
    "expected unique constraint unique_document_version on document_versions",
  );
  assert.ok(
    environmentsTable.uniqueConstraints.unique_environment_id_project,
    "expected unique constraint unique_environment_id_project on environments",
  );
  assert.ok(
    environmentsTable.uniqueConstraints.unique_environment_per_project,
    "expected unique constraint unique_environment_per_project on environments",
  );

  assert.ok(
    apiKeysTable.uniqueConstraints.uniq_api_keys_key_hash,
    "expected unique constraint uniq_api_keys_key_hash on api_keys",
  );
  assert.ok(
    apiKeysTable.indexes.idx_api_keys_created_by,
    "expected index idx_api_keys_created_by on api_keys",
  );
  assert.ok(
    cliLoginChallengesTable.indexes.idx_cli_login_challenges_status_expires,
    "expected index idx_cli_login_challenges_status_expires on cli_login_challenges",
  );
  assert.ok(
    cliLoginChallengesTable.indexes.idx_cli_login_challenges_user,
    "expected index idx_cli_login_challenges_user on cli_login_challenges",
  );
  assert.ok(
    authLoginBackoffsTable.uniqueConstraints.uniq_auth_login_backoffs_login_key,
    "expected unique constraint uniq_auth_login_backoffs_login_key on auth_login_backoffs",
  );
  assert.ok(
    authLoginBackoffsTable.indexes.idx_auth_login_backoffs_next_allowed,
    "expected index idx_auth_login_backoffs_next_allowed on auth_login_backoffs",
  );
  assert.ok(
    cliLoginChallengesTable.foreignKeys
      .cli_login_challenges_user_id_users_id_fk,
    "expected foreign key cli_login_challenges_user_id_users_id_fk on cli_login_challenges",
  );
  assert.ok(
    rbacGrantsTable.indexes.idx_rbac_grants_user_active,
    "expected index idx_rbac_grants_user_active on rbac_grants",
  );
  assert.ok(
    rbacGrantsTable.indexes.idx_rbac_grants_scope_active,
    "expected index idx_rbac_grants_scope_active on rbac_grants",
  );
  assert.ok(
    rbacGrantsTable.foreignKeys.rbac_grants_user_id_users_id_fk,
    "expected foreign key rbac_grants_user_id_users_id_fk on rbac_grants",
  );
  assert.ok(
    rbacGrantsTable.foreignKeys.rbac_grants_created_by_user_id_users_id_fk,
    "expected foreign key rbac_grants_created_by_user_id_users_id_fk on rbac_grants",
  );
  assert.ok(
    authUsersTable.uniqueConstraints.uniq_auth_users_email,
    "expected unique constraint uniq_auth_users_email on users",
  );
  assert.ok(
    authSessionsTable.uniqueConstraints.uniq_auth_sessions_token,
    "expected unique constraint uniq_auth_sessions_token on sessions",
  );
  assert.ok(
    authSessionsTable.indexes.idx_auth_sessions_user_id,
    "expected index idx_auth_sessions_user_id on sessions",
  );
  assert.ok(
    authAccountsTable.indexes.idx_auth_accounts_user_id,
    "expected index idx_auth_accounts_user_id on accounts",
  );
  assert.ok(
    authVerificationsTable.indexes.idx_auth_verifications_identifier,
    "expected index idx_auth_verifications_identifier on verifications",
  );
  assert.ok(
    schemaSyncsTable.uniqueConstraints.unique_schema_sync_per_environment,
    "expected unique constraint unique_schema_sync_per_environment on schema_syncs",
  );
  assert.ok(
    schemaSyncsTable.indexes.idx_schema_syncs_scope,
    "expected index idx_schema_syncs_scope on schema_syncs",
  );
  assert.ok(
    schemaSyncsTable.foreignKeys.fk_schema_syncs_env_project,
    "expected foreign key fk_schema_syncs_env_project on schema_syncs",
  );
  assert.ok(
    webhooksTable.indexes.idx_webhooks_scope,
    "expected index idx_webhooks_scope on webhooks",
  );
  assert.ok(
    webhooksTable.indexes.idx_webhooks_active_event_lookup,
    "expected index idx_webhooks_active_event_lookup on webhooks",
  );
  assert.ok(
    webhooksTable.foreignKeys.fk_webhooks_env_project,
    "expected foreign key fk_webhooks_env_project on webhooks",
  );
  assert.ok(
    webhooksTable.checkConstraints.webhooks_events_check,
    "expected check constraint webhooks_events_check on webhooks",
  );
  assert.ok(
    webhookDeliveryAttemptsTable.indexes.idx_webhook_delivery_attempts_scope,
    "expected index idx_webhook_delivery_attempts_scope on webhook_delivery_attempts",
  );
  assert.ok(
    webhookDeliveryAttemptsTable.indexes.idx_webhook_delivery_attempts_filters,
    "expected index idx_webhook_delivery_attempts_filters on webhook_delivery_attempts",
  );
  assert.ok(
    webhookDeliveryAttemptsTable.foreignKeys
      .fk_webhook_delivery_attempts_env_project,
    "expected foreign key fk_webhook_delivery_attempts_env_project on webhook_delivery_attempts",
  );
  assert.ok(
    webhookDeliveryAttemptsTable.checkConstraints
      .webhook_delivery_attempts_event_check,
    "expected check constraint webhook_delivery_attempts_event_check on webhook_delivery_attempts",
  );
  assert.ok(
    projectEnvironmentTopologySnapshotsTable.uniqueConstraints
      .unique_project_environment_topology_snapshot,
    "expected unique constraint unique_project_environment_topology_snapshot on project_environment_topology_snapshots",
  );
  assert.ok(
    schemaRegistryEntriesTable.uniqueConstraints
      .unique_schema_registry_entry_per_type,
    "expected unique constraint unique_schema_registry_entry_per_type on schema_registry_entries",
  );
  assert.ok(
    schemaRegistryEntriesTable.indexes.idx_schema_registry_entries_scope,
    "expected index idx_schema_registry_entries_scope on schema_registry_entries",
  );
  assert.ok(
    schemaRegistryEntriesTable.foreignKeys
      .fk_schema_registry_entries_env_project,
    "expected foreign key fk_schema_registry_entries_env_project on schema_registry_entries",
  );
  assert.ok(
    projectMediaSettingsTable.checkConstraints
      .project_media_settings_image_max_size_positive,
    "expected check constraint project_media_settings_image_max_size_positive on project_media_settings",
  );
  assert.deepEqual(
    projectMediaSettingsTable.foreignKeys
      .project_media_settings_project_id_projects_id_fk,
    {
      name: "project_media_settings_project_id_projects_id_fk",
      tableFrom: "project_media_settings",
      tableTo: "projects",
      columnsFrom: ["project_id"],
      columnsTo: ["id"],
      onDelete: "no action",
      onUpdate: "no action",
    },
    "expected project_media_settings.project_id to reference projects.id",
  );
  assert.equal(
    projectMediaSettingsTable.checkConstraints
      .project_media_settings_image_max_size_positive.value,
    '"project_media_settings"."image_max_upload_size_bytes" is null or "project_media_settings"."image_max_upload_size_bytes" > 0',
    "expected image max upload size constraint to allow null or positive values only",
  );
  assert.deepEqual(
    publishedSearchIndexTable.columns.search_config,
    {
      name: "search_config",
      type: "regconfig",
      primaryKey: false,
      notNull: true,
    },
    "expected published_search_index.search_config to be non-null REGCONFIG",
  );
  assert.deepEqual(
    publishedSearchIndexTable.columns.search_vector,
    {
      name: "search_vector",
      type: "tsvector",
      primaryKey: false,
      notNull: true,
    },
    "expected published_search_index.search_vector to be non-null TSVECTOR",
  );
  assert.equal(
    publishedSearchIndexTable.indexes.idx_published_search_vector.method,
    "gin",
    "expected idx_published_search_vector to use GIN",
  );
  assert.deepEqual(
    indexColumnExpressions(
      publishedSearchIndexTable.indexes.idx_published_search_vector,
    ),
    ["search_vector"],
    "expected idx_published_search_vector to cover only search_vector",
  );
  assert.ok(
    publishedSearchIndexTable.indexes.idx_published_search_scope_type_locale,
    "expected scope/type/locale index on published_search_index",
  );
  assert.deepEqual(
    indexColumnExpressions(
      publishedSearchIndexTable.indexes.idx_published_search_scope_type_locale,
    ),
    ["project_id", "environment_id", "schema_type", "locale"],
    "expected published search scope/type/locale index column order",
  );
  assert.deepEqual(
    publishedSearchIndexTable.compositePrimaryKeys.published_search_index_pkey,
    {
      name: "published_search_index_pkey",
      columns: ["project_id", "environment_id", "document_id", "locale"],
    },
    "expected published_search_index primary key column order",
  );
  assert.deepEqual(
    publishedSearchIndexTable.foreignKeys.fk_published_search_index_document,
    {
      name: "fk_published_search_index_document",
      tableFrom: "published_search_index",
      tableTo: "documents",
      columnsFrom: ["document_id"],
      columnsTo: ["document_id"],
      onDelete: "cascade",
      onUpdate: "no action",
    },
    "expected published_search_index.document_id to cascade with documents",
  );
  assert.deepEqual(
    publishedSearchIndexTable.foreignKeys
      .fk_published_search_index_document_scope,
    {
      name: "fk_published_search_index_document_scope",
      tableFrom: "published_search_index",
      tableTo: "documents",
      columnsFrom: ["document_id", "project_id", "environment_id"],
      columnsTo: ["document_id", "project_id", "environment_id"],
      onDelete: "cascade",
      onUpdate: "no action",
    },
    "expected published_search_index scope to match the referenced document",
  );
  assert.deepEqual(
    publishedSearchIndexTable.foreignKeys.fk_published_search_index_env_project,
    {
      name: "fk_published_search_index_env_project",
      tableFrom: "published_search_index",
      tableTo: "environments",
      columnsFrom: ["environment_id", "project_id"],
      columnsTo: ["id", "project_id"],
      onDelete: "no action",
      onUpdate: "no action",
    },
    "expected published_search_index environment to belong to the indexed project",
  );
});

test("migration SQL encodes published-version delete restriction and no extension setup", () => {
  const { allMigrationSql } = readLatestArtifacts();

  assert.match(
    allMigrationSql,
    /CONSTRAINT "fk_documents_published_version".*ON DELETE restrict/i,
    "expected fk_documents_published_version to enforce ON DELETE RESTRICT",
  );
  assert.equal(
    /create extension/i.test(allMigrationSql),
    false,
    "migration SQL must not include extension setup statements",
  );
  assert.equal(
    /uuid-ossp/i.test(allMigrationSql),
    false,
    "migration SQL must not depend on uuid-ossp",
  );
  assert.equal(
    /pgcrypto/i.test(allMigrationSql),
    false,
    "migration SQL must not depend on pgcrypto",
  );
  assert.match(
    allMigrationSql,
    /CREATE TABLE "published_search_index"/i,
    "expected migration SQL to create published_search_index",
  );
  assert.match(
    allMigrationSql,
    /CONSTRAINT "published_search_index_pkey" PRIMARY KEY\("project_id","environment_id","document_id","locale"\)/i,
    "expected published_search_index primary key column order in SQL",
  );
  assert.match(
    allMigrationSql,
    /"search_config" regconfig NOT NULL/i,
    "expected migration SQL to use REGCONFIG",
  );
  assert.match(
    allMigrationSql,
    /"search_vector" tsvector NOT NULL/i,
    "expected migration SQL to use TSVECTOR",
  );
  assert.match(
    allMigrationSql,
    /CREATE INDEX "idx_published_search_vector" ON "published_search_index" USING gin \("search_vector"\)/i,
    "expected migration SQL to create GIN search_vector index",
  );
  assert.match(
    allMigrationSql,
    /CREATE INDEX "idx_published_search_scope_type_locale" ON "published_search_index" USING btree \("project_id","environment_id","schema_type","locale"\)/i,
    "expected migration SQL to create scope/type/locale index with stable column order",
  );
  assert.match(
    allMigrationSql,
    /ALTER TABLE "documents" ADD CONSTRAINT "unique_document_scope" UNIQUE\("document_id","project_id","environment_id"\)/i,
    "expected migration SQL to add document scope uniqueness for composite foreign keys",
  );
  assert.match(
    allMigrationSql,
    /ALTER TABLE "published_search_index" ADD CONSTRAINT "fk_published_search_index_env_project" FOREIGN KEY \("environment_id","project_id"\) REFERENCES "public"."environments"\("id","project_id"\) ON DELETE no action ON UPDATE no action/i,
    "expected migration SQL to enforce published_search_index environment/project scope",
  );
  assert.match(
    allMigrationSql,
    /ALTER TABLE "published_search_index" ADD CONSTRAINT "fk_published_search_index_document_scope" FOREIGN KEY \("document_id","project_id","environment_id"\) REFERENCES "public"."documents"\("document_id","project_id","environment_id"\) ON DELETE cascade ON UPDATE no action/i,
    "expected migration SQL to enforce published_search_index document scope",
  );
  assert.match(
    allMigrationSql,
    /INSERT INTO "published_search_index"/i,
    "expected migration SQL to backfill published search index rows",
  );
  assert.match(
    allMigrationSql,
    /INSERT INTO "published_search_index"[\s\S]+SELECT\s+"documents"\."project_id",\s+"documents"\."environment_id",\s+"document_versions"\."document_id",\s+"document_versions"\."locale",\s+"document_versions"\."schema_type"/i,
    "expected backfill to source constrained scope from documents while preserving published snapshot fields from document_versions",
  );
  assert.match(
    allMigrationSql,
    /INSERT INTO "published_search_index"[\s\S]+FROM "documents"\s+INNER JOIN "document_versions"[\s\S]+"document_versions"\."version" = "documents"\."published_version"/i,
    "expected backfill to join document_versions through documents.published_version",
  );
  assert.match(
    allMigrationSql,
    /WHERE "documents"\."is_deleted" = false\s+AND "documents"\."published_version" IS NOT NULL/i,
    "expected backfill to include only non-deleted documents with a published version",
  );
  assert.match(
    allMigrationSql,
    /concat_ws\(\s+E'\\n',\s+"document_versions"\."path",\s+regexp_replace\("document_versions"\."path",\s+'\[\/\._-\]\+',\s+' ',\s+'g'\),\s+"document_versions"\."body",\s+"document_versions"\."frontmatter"::text\s+\)/i,
    "expected backfill vector text to include separator-normalized path segments",
  );
});

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid().defaultRandom().primaryKey(),
  organizationId: uuid(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid().notNull(),
});

export const authUsers = pgTable(
  "users",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().default(false).notNull(),
    image: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("uniq_auth_users_email").on(table.email)],
);

export const authSessions = pgTable(
  "sessions",
  {
    id: text().primaryKey(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    token: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("uniq_auth_sessions_token").on(table.token),
    index("idx_auth_sessions_user_id").on(table.userId),
  ],
);

export const authAccounts = pgTable(
  "accounts",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_auth_accounts_user_id").on(table.userId)],
);

export const authVerifications = pgTable(
  "verifications",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_auth_verifications_identifier").on(table.identifier)],
);

export type ApiKeyScopeTuple = {
  project: string;
  environment: string;
};

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().defaultRandom().primaryKey(),
    label: text().notNull(),
    keyPrefix: text().notNull(),
    keyHash: text().notNull(),
    scopes: jsonb().$type<string[]>().notNull(),
    contextAllowlist: jsonb().$type<ApiKeyScopeTuple[]>().notNull(),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdByUserId: text()
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_api_keys_key_hash").on(table.keyHash),
    index("idx_api_keys_active").on(table.revokedAt, table.expiresAt),
    index("idx_api_keys_created_by").on(table.createdByUserId),
  ],
);

export const cliLoginChallenges = pgTable(
  "cli_login_challenges",
  {
    id: uuid().defaultRandom().primaryKey(),
    project: text().notNull(),
    environment: text().notNull(),
    redirectUri: text().notNull(),
    requestedScopes: jsonb().$type<string[]>().notNull(),
    stateHash: text().notNull(),
    authorizationCodeHash: text(),
    status: text().default("pending").notNull(),
    userId: text().references(() => authUsers.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    authorizedAt: timestamp({ withTimezone: true }),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table): any => [
    check(
      "cli_login_challenges_status_check",
      sql`${table.status} in ('pending', 'authorized', 'exchanged')`,
    ),
    index("idx_cli_login_challenges_status_expires").on(
      table.status,
      table.expiresAt,
    ),
    index("idx_cli_login_challenges_user").on(table.userId),
  ],
);

export const authLoginBackoffs = pgTable(
  "auth_login_backoffs",
  {
    id: uuid().defaultRandom().primaryKey(),
    loginKey: text().notNull(),
    failureCount: integer().default(0).notNull(),
    firstFailedAt: timestamp({ withTimezone: true }).notNull(),
    lastFailedAt: timestamp({ withTimezone: true }).notNull(),
    nextAllowedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_auth_login_backoffs_login_key").on(table.loginKey),
    index("idx_auth_login_backoffs_next_allowed").on(table.nextAllowedAt),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid().defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    email: text().notNull(),
    grants: jsonb()
      .$type<
        Array<{
          role: string;
          scopeKind: string;
          project?: string;
          environment?: string;
          pathPrefix?: string;
        }>
      >()
      .notNull(),
    createdByUserId: text()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    unique("uniq_invites_token_hash").on(table.tokenHash),
    index("idx_invites_email").on(table.email),
    index("idx_invites_status").on(
      table.acceptedAt,
      table.revokedAt,
      table.expiresAt,
    ),
  ],
);

export const rbacGrants = pgTable(
  "rbac_grants",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: text()
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text().notNull(),
    scopeKind: text().notNull(),
    project: text(),
    environment: text(),
    pathPrefix: text(),
    source: text(),
    createdByUserId: text().references(() => authUsers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (table): any => [
    check(
      "rbac_grants_role_check",
      sql`${table.role} in ('owner', 'admin', 'editor', 'viewer')`,
    ),
    check(
      "rbac_grants_scope_kind_check",
      sql`${table.scopeKind} in ('global', 'project', 'folder_prefix')`,
    ),
    check(
      "rbac_grants_scope_fields_check",
      sql`(
        (${table.scopeKind} = 'global' and ${table.project} is null and ${table.environment} is null and ${table.pathPrefix} is null)
        or
        (${table.scopeKind} = 'project' and ${table.project} is not null and ${table.environment} is null and ${table.pathPrefix} is null)
        or
        (${table.scopeKind} = 'folder_prefix' and ${table.project} is not null and ${table.environment} is not null and ${table.pathPrefix} is not null)
      )`,
    ),
    check(
      "rbac_grants_admin_owner_global_check",
      sql`(
        ${table.role} not in ('owner', 'admin')
        or ${table.scopeKind} = 'global'
      )`,
    ),
    index("idx_rbac_grants_user_active").on(
      table.userId,
      table.revokedAt,
      table.role,
    ),
    index("idx_rbac_grants_scope_active").on(
      table.scopeKind,
      table.project,
      table.environment,
      table.revokedAt,
    ),
  ],
);

export const environments = pgTable(
  "environments",
  {
    id: uuid().defaultRandom().primaryKey(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    name: text().notNull(),
    description: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid().notNull(),
  },
  (table) => [
    unique("unique_environment_id_project").on(table.id, table.projectId),
    unique("unique_environment_per_project").on(table.projectId, table.name),
  ],
);

export const schemaSyncs = pgTable(
  "schema_syncs",
  {
    id: uuid().defaultRandom().primaryKey(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id),
    schemaHash: text().notNull(),
    rawConfigSnapshot: jsonb().notNull(),
    syncedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("unique_schema_sync_per_environment").on(
      table.projectId,
      table.environmentId,
    ),
    foreignKey({
      name: "fk_schema_syncs_env_project",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }),
    index("idx_schema_syncs_scope").on(table.projectId, table.environmentId),
  ],
);

export const projectEnvironmentTopologySnapshots = pgTable(
  "project_environment_topology_snapshots",
  {
    id: uuid().defaultRandom().primaryKey(),
    project: text().notNull(),
    configSnapshotHash: text().notNull(),
    definitions: jsonb().notNull(),
    syncedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("unique_project_environment_topology_snapshot").on(table.project),
  ],
);

export const schemaRegistryEntries = pgTable(
  "schema_registry_entries",
  {
    id: uuid().defaultRandom().primaryKey(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id),
    schemaType: text().notNull(),
    directory: text().notNull(),
    localized: boolean().notNull(),
    schemaHash: text().notNull(),
    resolvedSchema: jsonb().notNull(),
    syncedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("unique_schema_registry_entry_per_type").on(
      table.projectId,
      table.environmentId,
      table.schemaType,
    ),
    foreignKey({
      name: "fk_schema_registry_entries_env_project",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }),
    index("idx_schema_registry_entries_scope").on(
      table.projectId,
      table.environmentId,
      table.schemaType,
    ),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid().defaultRandom().primaryKey(),
    documentId: uuid()
      .notNull()
      .references(() => documents.documentId),
    translationGroupId: uuid().notNull(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id),
    schemaType: text().notNull(),
    locale: text().notNull(),
    contentFormat: text().notNull(),
    path: text().notNull(),
    body: text().notNull(),
    frontmatter: jsonb().notNull(),
    version: integer().notNull(),
    publishedBy: uuid().notNull(),
    publishedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    changeSummary: text(),
  },
  (table): any => [
    check(
      "document_versions_content_format_check",
      sql`${table.contentFormat} in ('md', 'mdx')`,
    ),
    unique("unique_document_version").on(table.documentId, table.version),
    foreignKey({
      name: "fk_document_versions_env_project",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }),
    index("idx_versions_document").on(table.documentId, table.version.desc()),
    index("idx_versions_scope").on(
      table.projectId,
      table.environmentId,
      table.locale,
      table.schemaType,
    ),
  ],
);

export const documents = pgTable(
  "documents",
  {
    documentId: uuid().primaryKey(),
    translationGroupId: uuid().notNull(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id),
    path: text().notNull(),
    schemaType: text().notNull(),
    locale: text().notNull(),
    contentFormat: text().notNull(),
    body: text().notNull(),
    frontmatter: jsonb().notNull(),
    isDeleted: boolean().default(false).notNull(),
    hasUnpublishedChanges: boolean().default(true).notNull(),
    publishedVersion: integer(),
    draftRevision: bigint({ mode: "number" }).default(1).notNull(),
    createdBy: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedBy: uuid().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table): any => [
    check(
      "documents_content_format_check",
      sql`${table.contentFormat} in ('md', 'mdx')`,
    ),
    foreignKey({
      name: "fk_documents_env_project",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }),
    foreignKey({
      name: "fk_documents_published_version",
      columns: [table.documentId, table.publishedVersion],
      foreignColumns: [documentVersions.documentId, documentVersions.version],
    }).onDelete("restrict"),
    index("idx_documents_active_scope_type_locale_path")
      .on(
        table.projectId,
        table.environmentId,
        table.schemaType,
        table.locale,
        table.path.op("text_pattern_ops"),
      )
      .where(sql`${table.isDeleted} = false`),
    index("idx_documents_active_scope_updated_at")
      .on(table.projectId, table.environmentId, table.updatedAt.desc())
      .where(sql`${table.isDeleted} = false`),
    index("idx_documents_active_scope_unpublished_updated_at")
      .on(table.projectId, table.environmentId, table.updatedAt.desc())
      .where(
        sql`${table.isDeleted} = false and ${table.hasUnpublishedChanges} = true`,
      ),
    index("idx_documents_scope_translation_group").on(
      table.projectId,
      table.environmentId,
      table.translationGroupId,
    ),
    uniqueIndex("uniq_documents_active_path")
      .on(table.projectId, table.environmentId, table.locale, table.path)
      .where(sql`${table.isDeleted} = false`),
    uniqueIndex("uniq_documents_active_translation_locale")
      .on(
        table.projectId,
        table.environmentId,
        table.translationGroupId,
        table.locale,
      )
      .where(sql`${table.isDeleted} = false`),
  ],
);

export const media = pgTable("media", {
  id: uuid().defaultRandom().primaryKey(),
  projectId: uuid()
    .notNull()
    .references(() => projects.id),
  filename: text().notNull(),
  mimeType: text().notNull(),
  sizeBytes: bigint({ mode: "number" }).notNull(),
  s3Key: text().notNull(),
  url: text().notNull(),
  uploadedBy: uuid().notNull(),
  uploadedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid().defaultRandom().primaryKey(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id),
    url: text().notNull(),
    events: jsonb().$type<string[]>().notNull(),
    secret: text().notNull(),
    active: boolean().default(true).notNull(),
    createdBy: text()
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    updatedBy: text()
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table): any => [
    foreignKey({
      name: "fk_webhooks_env_project",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }),
    index("idx_webhooks_scope").on(
      table.projectId,
      table.environmentId,
      table.createdAt.desc(),
    ),
    index("idx_webhooks_active_event_lookup")
      .using("gin", table.events)
      .where(sql`${table.active} = true`),
  ],
);

export const webhookDeliveryAttempts = pgTable(
  "webhook_delivery_attempts",
  {
    id: uuid().defaultRandom().primaryKey(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id),
    webhookId: uuid().notNull(),
    event: text().notNull(),
    eventId: uuid().notNull(),
    deliveryId: uuid().notNull(),
    url: text().notNull(),
    attempt: integer().notNull(),
    maxAttempts: integer().notNull(),
    outcome: text().notNull(),
    statusCode: integer(),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (table): any => [
    check("webhook_delivery_attempts_attempt_check", sql`${table.attempt} > 0`),
    check(
      "webhook_delivery_attempts_max_attempts_check",
      sql`${table.maxAttempts} > 0`,
    ),
    check(
      "webhook_delivery_attempts_attempt_le_max_attempts_check",
      sql`${table.attempt} <= ${table.maxAttempts}`,
    ),
    check(
      "webhook_delivery_attempts_outcome_check",
      sql`${table.outcome} in ('succeeded', 'retrying', 'failed', 'discarded')`,
    ),
    check(
      "webhook_delivery_attempts_status_code_check",
      sql`${table.statusCode} is null or (${table.statusCode} >= 100 and ${table.statusCode} <= 599)`,
    ),
    foreignKey({
      name: "fk_webhook_delivery_attempts_env_project",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }),
    index("idx_webhook_delivery_attempts_scope").on(
      table.projectId,
      table.environmentId,
      table.createdAt.desc(),
    ),
    index("idx_webhook_delivery_attempts_filters").on(
      table.projectId,
      table.environmentId,
      table.webhookId,
      table.event,
      table.outcome,
      table.createdAt.desc(),
    ),
  ],
);

export const migrations = pgTable(
  "migrations",
  {
    id: uuid().defaultRandom().primaryKey(),
    name: text().notNull(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    environmentId: uuid().notNull(),
    schemaType: text().notNull(),
    appliedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    appliedBy: uuid().notNull(),
    documentsAffected: integer().notNull(),
  },
  (table) => [
    foreignKey({
      name: "fk_migrations_env_project",
      columns: [table.environmentId, table.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }),
    index("idx_migrations_scope").on(
      table.projectId,
      table.environmentId,
      table.appliedAt.desc(),
    ),
  ],
);

import { randomUUID } from "node:crypto";

import { RuntimeError, type SchemaRegistryTypeSnapshot } from "@mdcms/shared";
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";

import type { DrizzleDatabase } from "../db.js";
import {
  documents,
  documentVersions,
  schemaRegistryEntries,
  schemaSyncs,
} from "../db/schema.js";
import { resolveProjectEnvironmentScope } from "../project-provisioning.js";

import {
  DEFAULT_ACTOR,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type ContentDocument,
  type ContentFormat,
  type ContentScope,
  type ContentStore,
  type ContentWriteOperationOptions,
  type CreateDatabaseContentStoreOptions,
  type SortField,
  type SortOrder,
  sortVariantSummaries,
} from "./types.js";
import {
  assertJsonObject,
  assertRequiredString,
  parseBoolean,
  parseContentListGroupBy,
  parseContentSearchQuery,
  parseContentFormat,
  parseOptionalString,
  parsePositiveInt,
  parseSortField,
  parseSortOrder,
  validateContentPath,
} from "./parsing.js";
import {
  buildContentPathConflict,
  getUniqueConstraintName,
  isUniqueViolation,
  readDefaultLocale,
  readOrderedSupportedLocales,
  readSupportedLocales,
  toContentDocument,
  toContentVersionDocument,
  toIsoString,
} from "./responses.js";
import { groupDocumentsByTranslationGroup } from "./grouped-list.js";
import { validateMediaFieldIdentities } from "./media-field-validation.js";
import { validateReferenceFieldIdentities } from "./reference-validation.js";
import { createPostgresContentSearchBackend } from "./search.js";
import { matchesDeletedListVisibility } from "./visibility.js";

export function createDatabaseContentStore(
  options: CreateDatabaseContentStoreOptions,
): ContentStore {
  const { db, lookupMediaAsset } = options;
  const searchBackend =
    options.searchBackend ?? createPostgresContentSearchBackend(db);

  async function resolveScopeIds(
    scope: ContentScope,
    createIfMissing: boolean,
  ): Promise<{ projectId: string; environmentId: string } | undefined> {
    const resolvedScope = await resolveProjectEnvironmentScope(db, {
      project: scope.project,
      environment: scope.environment,
      createIfMissing,
    });

    if (!resolvedScope) {
      return undefined;
    }

    return {
      projectId: resolvedScope.project.id,
      environmentId: resolvedScope.environment.id,
    };
  }

  async function findPathConflict(
    scopeIds: { projectId: string; environmentId: string },
    input: { path: string; locale: string; documentId?: string },
  ): Promise<typeof documents.$inferSelect | undefined> {
    const baseConditions: SQL[] = [
      eq(documents.projectId, scopeIds.projectId),
      eq(documents.environmentId, scopeIds.environmentId),
      eq(documents.path, input.path),
      eq(documents.locale, input.locale),
      eq(documents.isDeleted, false),
    ];

    if (input.documentId) {
      baseConditions.push(ne(documents.documentId, input.documentId));
    }

    return db.query.documents.findFirst({
      where: and(...baseConditions),
    });
  }

  async function findTranslationLocaleConflict(
    scopeIds: { projectId: string; environmentId: string },
    input: {
      translationGroupId: string;
      locale: string;
      documentId?: string;
    },
  ): Promise<typeof documents.$inferSelect | undefined> {
    const baseConditions: SQL[] = [
      eq(documents.projectId, scopeIds.projectId),
      eq(documents.environmentId, scopeIds.environmentId),
      eq(documents.translationGroupId, input.translationGroupId),
      eq(documents.locale, input.locale),
      eq(documents.isDeleted, false),
    ];

    if (input.documentId) {
      baseConditions.push(ne(documents.documentId, input.documentId));
    }

    return db.query.documents.findFirst({
      where: and(...baseConditions),
    });
  }

  async function resolveSourceDocument(
    scopeIds: { projectId: string; environmentId: string },
    sourceDocumentId: string,
  ): Promise<typeof documents.$inferSelect | undefined> {
    return db.query.documents.findFirst({
      where: and(
        eq(documents.projectId, scopeIds.projectId),
        eq(documents.environmentId, scopeIds.environmentId),
        eq(documents.documentId, sourceDocumentId),
        eq(documents.isDeleted, false),
      ),
    });
  }

  async function assertExpectedSchemaHash(
    executor: DrizzleDatabase,
    scope: ContentScope,
    scopeIds: { projectId: string; environmentId: string },
    expectedSchemaHash?: string,
  ): Promise<void> {
    if (!expectedSchemaHash) {
      return;
    }

    const [schemaSync] = await executor
      .select({
        schemaHash: schemaSyncs.schemaHash,
      })
      .from(schemaSyncs)
      .where(
        and(
          eq(schemaSyncs.projectId, scopeIds.projectId),
          eq(schemaSyncs.environmentId, scopeIds.environmentId),
        ),
      )
      .for("update");

    if (!schemaSync) {
      throw new RuntimeError({
        code: "SCHEMA_NOT_SYNCED",
        message:
          'Target project/environment has no synced schema. Run "cms schema sync" before writing content.',
        statusCode: 409,
        details: {
          project: scope.project,
          environment: scope.environment,
        },
      });
    }

    if (schemaSync.schemaHash === expectedSchemaHash) {
      return;
    }

    throw new RuntimeError({
      code: "SCHEMA_HASH_MISMATCH",
      message:
        "Client schema hash does not match the server schema hash for the target project/environment.",
      statusCode: 409,
      details: {
        project: scope.project,
        environment: scope.environment,
        clientSchemaHash: expectedSchemaHash,
        serverSchemaHash: schemaSync.schemaHash,
      },
    });
  }

  async function resolveVariantLocalePolicy(
    scopeIds: { projectId: string; environmentId: string },
    type: string,
  ): Promise<
    | {
        localized: boolean;
        defaultLocale?: string;
        orderedSupportedLocales?: string[];
        supportedLocales?: Set<string>;
      }
    | undefined
  > {
    const [schemaEntry, schemaSync] = await Promise.all([
      db.query.schemaRegistryEntries.findFirst({
        where: and(
          eq(schemaRegistryEntries.projectId, scopeIds.projectId),
          eq(schemaRegistryEntries.environmentId, scopeIds.environmentId),
          eq(schemaRegistryEntries.schemaType, type),
        ),
      }),
      db.query.schemaSyncs.findFirst({
        where: and(
          eq(schemaSyncs.projectId, scopeIds.projectId),
          eq(schemaSyncs.environmentId, scopeIds.environmentId),
        ),
      }),
    ]);

    if (!schemaEntry) {
      return undefined;
    }

    return {
      localized: schemaEntry.localized,
      defaultLocale: readDefaultLocale(schemaSync?.rawConfigSnapshot),
      orderedSupportedLocales: readOrderedSupportedLocales(
        schemaSync?.rawConfigSnapshot,
      ),
      supportedLocales: readSupportedLocales(schemaSync?.rawConfigSnapshot),
    };
  }

  async function resolveTypeSchema(
    scopeIds: { projectId: string; environmentId: string },
    type: string,
  ): Promise<SchemaRegistryTypeSnapshot | undefined> {
    const row = await db.query.schemaRegistryEntries.findFirst({
      where: and(
        eq(schemaRegistryEntries.projectId, scopeIds.projectId),
        eq(schemaRegistryEntries.environmentId, scopeIds.environmentId),
        eq(schemaRegistryEntries.schemaType, type),
      ),
    });

    return row?.resolvedSchema as SchemaRegistryTypeSnapshot | undefined;
  }

  async function resolvePublishedSnapshot(
    scopeIds: { projectId: string; environmentId: string },
    headRow: typeof documents.$inferSelect,
  ): Promise<ContentDocument | undefined> {
    if (headRow.isDeleted || headRow.publishedVersion === null) {
      return undefined;
    }

    const versionRow = await db.query.documentVersions.findFirst({
      where: and(
        eq(documentVersions.projectId, scopeIds.projectId),
        eq(documentVersions.environmentId, scopeIds.environmentId),
        eq(documentVersions.documentId, headRow.documentId),
        eq(documentVersions.version, headRow.publishedVersion),
      ),
    });

    if (!versionRow) {
      return undefined;
    }

    return {
      documentId: headRow.documentId,
      translationGroupId: headRow.translationGroupId,
      project: "",
      environment: "",
      path: versionRow.path,
      type: versionRow.schemaType,
      locale: versionRow.locale,
      format: versionRow.contentFormat as ContentFormat,
      isDeleted: headRow.isDeleted,
      hasUnpublishedChanges: headRow.hasUnpublishedChanges,
      version: versionRow.version,
      publishedVersion: headRow.publishedVersion,
      draftRevision: headRow.draftRevision,
      frontmatter: versionRow.frontmatter as Record<string, unknown>,
      body: versionRow.body,
      createdBy: headRow.createdBy,
      createdAt: toIsoString(headRow.createdAt),
      updatedBy: headRow.updatedBy,
      updatedAt: toIsoString(versionRow.publishedAt),
    };
  }

  async function resolvePublishedSearchLocale(
    executor: DrizzleDatabase,
    scopeIds: { projectId: string; environmentId: string },
    headRow: typeof documents.$inferSelect,
  ): Promise<string> {
    if (headRow.publishedVersion === null) {
      return headRow.locale;
    }

    const [versionRow] = await executor
      .select({
        locale: documentVersions.locale,
      })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.projectId, scopeIds.projectId),
          eq(documentVersions.environmentId, scopeIds.environmentId),
          eq(documentVersions.documentId, headRow.documentId),
          eq(documentVersions.version, headRow.publishedVersion),
        ),
      );

    return versionRow?.locale ?? headRow.locale;
  }

  async function upsertPublishedSearchDocument(
    executor: DrizzleDatabase,
    scopeIds: { projectId: string; environmentId: string },
    headRow: typeof documents.$inferSelect,
  ): Promise<void> {
    if (headRow.publishedVersion === null) {
      return;
    }

    const [versionRow] = await executor
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.projectId, scopeIds.projectId),
          eq(documentVersions.environmentId, scopeIds.environmentId),
          eq(documentVersions.documentId, headRow.documentId),
          eq(documentVersions.version, headRow.publishedVersion),
        ),
      );

    if (!versionRow) {
      return;
    }

    await searchBackend.upsertPublishedDocument(executor, {
      projectId: scopeIds.projectId,
      environmentId: scopeIds.environmentId,
      documentId: headRow.documentId,
      path: versionRow.path,
      type: versionRow.schemaType,
      locale: versionRow.locale,
      frontmatter: versionRow.frontmatter as Record<string, unknown>,
      body: versionRow.body,
    });
  }

  async function resolveHeadRow(
    scopeIds: { projectId: string; environmentId: string },
    documentId: string,
  ): Promise<typeof documents.$inferSelect | undefined> {
    return db.query.documents.findFirst({
      where: and(
        eq(documents.projectId, scopeIds.projectId),
        eq(documents.environmentId, scopeIds.environmentId),
        eq(documents.documentId, documentId),
      ),
    });
  }

  async function resolveVersionRow(
    scopeIds: { projectId: string; environmentId: string },
    documentId: string,
    version: number,
  ): Promise<typeof documentVersions.$inferSelect | undefined> {
    return db.query.documentVersions.findFirst({
      where: and(
        eq(documentVersions.projectId, scopeIds.projectId),
        eq(documentVersions.environmentId, scopeIds.environmentId),
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.version, version),
      ),
    });
  }

  async function getNextVersionNumber(
    tx: DrizzleDatabase,
    documentId: string,
  ): Promise<number> {
    const [latestVersionRow] = await tx
      .select({
        value: sql<number>`coalesce(max(${documentVersions.version}), 0)`,
      })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));

    return (latestVersionRow?.value ?? 0) + 1;
  }

  async function insertPublishedVersionRow(
    tx: DrizzleDatabase,
    input: {
      headRow: typeof documents.$inferSelect;
      snapshot: {
        path: string;
        type: string;
        locale: string;
        format: ContentFormat;
        frontmatter: Record<string, unknown>;
        body: string;
      };
      version: number;
      actorId: string;
      changeSummary?: string;
    },
  ): Promise<void> {
    await tx.insert(documentVersions).values({
      documentId: input.headRow.documentId,
      translationGroupId: input.headRow.translationGroupId,
      projectId: input.headRow.projectId,
      environmentId: input.headRow.environmentId,
      schemaType: input.snapshot.type,
      locale: input.snapshot.locale,
      contentFormat: input.snapshot.format,
      path: input.snapshot.path,
      body: input.snapshot.body,
      frontmatter: input.snapshot.frontmatter,
      version: input.version,
      publishedBy: input.actorId,
      changeSummary: input.changeSummary ?? null,
    });
    await searchBackend.upsertPublishedDocument(tx, {
      projectId: input.headRow.projectId,
      environmentId: input.headRow.environmentId,
      documentId: input.headRow.documentId,
      path: input.snapshot.path,
      type: input.snapshot.type,
      locale: input.snapshot.locale,
      frontmatter: input.snapshot.frontmatter,
      body: input.snapshot.body,
    });
  }

  function applyListFilters(
    document: ContentDocument,
    query: {
      draft: boolean;
      type?: string;
      path?: string;
      locale?: string;
      slug?: string;
      published?: boolean;
      isDeleted?: boolean;
      hasUnpublishedChanges?: boolean;
      matchingSearchDocumentIds?: Set<string>;
    },
  ): boolean {
    if (query.type && document.type !== query.type) {
      return false;
    }

    if (query.path && !document.path.startsWith(query.path)) {
      return false;
    }

    if (query.locale && document.locale !== query.locale) {
      return false;
    }

    if (
      query.slug &&
      String(document.frontmatter.slug ?? "").trim() !== query.slug
    ) {
      return false;
    }

    if (query.published !== undefined) {
      const isPublished = document.publishedVersion !== null;

      if (isPublished !== query.published) {
        return false;
      }
    }

    if (!matchesDeletedListVisibility(document, query)) {
      return false;
    }

    if (
      query.hasUnpublishedChanges !== undefined &&
      document.hasUnpublishedChanges !== query.hasUnpublishedChanges
    ) {
      return false;
    }

    if (
      query.matchingSearchDocumentIds &&
      !query.matchingSearchDocumentIds.has(document.documentId)
    ) {
      return false;
    }

    return true;
  }

  function sortDocuments(
    rows: ContentDocument[],
    sort: SortField,
    order: SortOrder,
  ): ContentDocument[] {
    rows.sort((left, right) => {
      let compared = 0;

      if (sort === "path") {
        compared = left.path.localeCompare(right.path);
      } else if (sort === "createdAt") {
        compared = left.createdAt.localeCompare(right.createdAt);
      } else {
        compared = left.updatedAt.localeCompare(right.updatedAt);
      }

      return order === "asc" ? compared : compared * -1;
    });

    return rows;
  }

  return {
    async getSchema(scope, type) {
      const normalizedType = assertRequiredString(type, "type");
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        return undefined;
      }

      const row = await db.query.schemaRegistryEntries.findFirst({
        where: and(
          eq(schemaRegistryEntries.projectId, scopeIds.projectId),
          eq(schemaRegistryEntries.environmentId, scopeIds.environmentId),
          eq(schemaRegistryEntries.schemaType, normalizedType),
        ),
      });

      return row?.resolvedSchema as SchemaRegistryTypeSnapshot | undefined;
    },

    async create(scope, payload, options?: ContentWriteOperationOptions) {
      const path = validateContentPath(
        assertRequiredString(payload.path, "path"),
      );
      const type = assertRequiredString(payload.type, "type");
      const locale = assertRequiredString(payload.locale, "locale");
      const sourceDocumentId = parseOptionalString(
        payload.sourceDocumentId,
        "sourceDocumentId",
      );
      const body = assertRequiredString(payload.body, "body", {
        allowEmpty: true,
      });
      const frontmatter = assertJsonObject(payload.frontmatter, "frontmatter");
      const format = parseContentFormat(payload.format);
      const scopeIds = await resolveScopeIds(scope, true);

      if (!scopeIds) {
        throw new RuntimeError({
          code: "INVALID_TARGET_ROUTING",
          message: "Requested project/environment target does not exist.",
          statusCode: 404,
        });
      }

      const sourceDocument = sourceDocumentId
        ? await resolveSourceDocument(scopeIds, sourceDocumentId)
        : undefined;

      if (sourceDocumentId && !sourceDocument) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: sourceDocumentId,
          },
        });
      }

      if (sourceDocument && sourceDocument.schemaType !== type) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message:
            'Field "type" must match the source document type when creating a translation variant.',
          statusCode: 400,
          details: {
            field: "type",
            sourceDocumentId,
          },
        });
      }

      if (sourceDocument) {
        const variantLocalePolicy = await resolveVariantLocalePolicy(
          scopeIds,
          type,
        );

        if (variantLocalePolicy && !variantLocalePolicy.localized) {
          throw new RuntimeError({
            code: "INVALID_INPUT",
            message:
              'Field "sourceDocumentId" can only be used with localized schema types.',
            statusCode: 400,
            details: {
              field: "sourceDocumentId",
              sourceDocumentId,
              type,
            },
          });
        }

        if (
          variantLocalePolicy?.supportedLocales &&
          !variantLocalePolicy.supportedLocales.has(locale)
        ) {
          throw new RuntimeError({
            code: "INVALID_INPUT",
            message:
              'Field "locale" must resolve to a supported locale when creating a translation variant.',
            statusCode: 400,
            details: {
              field: "locale",
              locale,
              sourceDocumentId,
              supportedLocales: [...variantLocalePolicy.supportedLocales].sort(
                (left, right) => left.localeCompare(right),
              ),
            },
          });
        }
      }

      const schema = await resolveTypeSchema(scopeIds, type);

      if (!schema) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message: 'Field "type" must reference a synced schema type.',
          statusCode: 400,
          details: {
            field: "type",
            type,
          },
        });
      }

      await validateReferenceFieldIdentities({
        schema,
        frontmatter,
        lookupTarget: async (documentId) => {
          const row = await resolveHeadRow(scopeIds, documentId);

          if (!row) {
            return undefined;
          }

          return {
            documentId: row.documentId,
            type: row.schemaType,
            isDeleted: row.isDeleted,
          };
        },
      });
      const { frontmatter: normalizedFrontmatter } =
        await validateMediaFieldIdentities({
          schema,
          frontmatter,
          scope,
          lookupMediaAsset,
        });

      const conflict = await findPathConflict(scopeIds, {
        path,
        locale,
      });

      if (conflict) {
        throw new RuntimeError({
          code: "CONTENT_PATH_CONFLICT",
          message:
            "A non-deleted document with the same path and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: conflict.documentId,
            path,
            locale,
          },
        });
      }

      const translationGroupId =
        sourceDocument?.translationGroupId ?? randomUUID();
      const translationConflict = await findTranslationLocaleConflict(
        scopeIds,
        {
          translationGroupId,
          locale,
        },
      );

      if (translationConflict) {
        throw new RuntimeError({
          code: "TRANSLATION_VARIANT_CONFLICT",
          message:
            "A non-deleted document with the same translation group and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: translationConflict.documentId,
            translationGroupId,
            locale,
          },
        });
      }

      const actor = payload.createdBy?.trim() || DEFAULT_ACTOR;

      try {
        const created = await db.transaction(async (tx) => {
          await assertExpectedSchemaHash(
            tx as unknown as DrizzleDatabase,
            scope,
            scopeIds,
            options?.expectedSchemaHash,
          );
          const [created] = await tx
            .insert(documents)
            .values({
              documentId: randomUUID(),
              translationGroupId,
              projectId: scopeIds.projectId,
              environmentId: scopeIds.environmentId,
              path,
              schemaType: type,
              locale,
              contentFormat: format,
              body,
              frontmatter: normalizedFrontmatter,
              isDeleted: false,
              hasUnpublishedChanges: true,
              publishedVersion: null,
              draftRevision: 1,
              createdBy: actor,
              updatedBy: actor,
            })
            .returning();

          return created;
        });

        if (!created) {
          throw new RuntimeError({
            code: "INTERNAL_ERROR",
            message: "Failed to create content document.",
            statusCode: 500,
          });
        }

        return toContentDocument(scope, created);
      } catch (error) {
        if (isUniqueViolation(error)) {
          const pathConflict = await findPathConflict(scopeIds, {
            path,
            locale,
          });

          if (pathConflict) {
            throw new RuntimeError({
              code: "CONTENT_PATH_CONFLICT",
              message:
                "A non-deleted document with the same path and locale already exists.",
              statusCode: 409,
              details: {
                conflictDocumentId: pathConflict.documentId,
                path,
                locale,
              },
            });
          }

          const translationConflict = await findTranslationLocaleConflict(
            scopeIds,
            {
              translationGroupId,
              locale,
            },
          );

          if (translationConflict) {
            throw new RuntimeError({
              code: "TRANSLATION_VARIANT_CONFLICT",
              message:
                "A non-deleted document with the same translation group and locale already exists.",
              statusCode: 409,
              details: {
                conflictDocumentId: translationConflict.documentId,
                translationGroupId,
                locale,
              },
            });
          }

          if (
            getUniqueConstraintName(error) ===
            "uniq_documents_active_translation_locale"
          ) {
            throw new RuntimeError({
              code: "TRANSLATION_VARIANT_CONFLICT",
              message:
                "A non-deleted document with the same translation group and locale already exists.",
              statusCode: 409,
              details: {
                translationGroupId,
                locale,
              },
            });
          }

          throw new RuntimeError({
            code: "CONTENT_PATH_CONFLICT",
            message:
              "A non-deleted document with the same path and locale already exists.",
            statusCode: 409,
            details: {
              path,
              locale,
            },
          });
        }

        throw error;
      }
    },

    async list(scope, query) {
      const limit = parsePositiveInt(query.limit, "limit", {
        defaultValue: DEFAULT_LIMIT,
        min: 1,
        max: MAX_LIMIT,
      });
      const offset = parsePositiveInt(query.offset, "offset", {
        defaultValue: 0,
        min: 0,
      });
      const published = parseBoolean(query.published, "published");
      const isDeleted = parseBoolean(query.isDeleted, "isDeleted");
      const hasUnpublishedChanges = parseBoolean(
        query.hasUnpublishedChanges,
        "hasUnpublishedChanges",
      );
      const draft = parseBoolean(query.draft, "draft") === true;

      const sort = parseSortField(query.sort);
      const order = parseSortOrder(query.order);
      const normalizedType = query.type?.trim();
      const normalizedPath = query.path?.trim();
      const normalizedLocale = query.locale?.trim();
      const normalizedSlug = query.slug?.trim();
      const normalizedQ = parseContentSearchQuery(query.q);
      const groupBy = parseContentListGroupBy(query.groupBy);
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        return {
          rows: [],
          total: 0,
          limit,
          offset,
        };
      }

      const matchingSearchDocumentIds = normalizedQ
        ? draft
          ? await searchBackend.searchDraftDocumentIds(scopeIds, {
              query: normalizedQ,
              type: normalizedType,
              locale: normalizedLocale,
              isDeleted,
            })
          : await searchBackend.searchPublishedDocumentIds(scopeIds, {
              query: normalizedQ,
              type: normalizedType,
              locale: normalizedLocale,
            })
        : undefined;

      if (
        matchingSearchDocumentIds !== undefined &&
        matchingSearchDocumentIds.size === 0
      ) {
        return {
          rows: [],
          total: 0,
          limit,
          offset,
        };
      }

      const headRows = await db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.projectId, scopeIds.projectId),
            eq(documents.environmentId, scopeIds.environmentId),
          ),
        );

      const resolvedRows: ContentDocument[] = [];

      for (const row of headRows) {
        if (draft) {
          resolvedRows.push(toContentDocument(scope, row));
          continue;
        }

        const publishedSnapshot = await resolvePublishedSnapshot(scopeIds, row);

        if (publishedSnapshot) {
          resolvedRows.push({
            ...publishedSnapshot,
            project: scope.project,
            environment: scope.environment,
          });
        }
      }

      const filteredRows = resolvedRows.filter((document) =>
        applyListFilters(document, {
          draft,
          type: normalizedType,
          path: normalizedPath,
          locale: normalizedLocale,
          slug: normalizedSlug,
          published,
          isDeleted,
          hasUnpublishedChanges,
          matchingSearchDocumentIds,
        }),
      );

      const localePolicy =
        groupBy === "translationGroup" && normalizedType
          ? await resolveVariantLocalePolicy(scopeIds, normalizedType)
          : undefined;
      const sortedRows =
        groupBy === "translationGroup" && normalizedType
          ? groupDocumentsByTranslationGroup({
              matchedRows: filteredRows,
              allRows: resolvedRows.filter(
                (document) =>
                  document.type === normalizedType &&
                  document.isDeleted === false,
              ),
              sort,
              order,
              defaultLocale: localePolicy?.defaultLocale,
              supportedLocales: localePolicy?.orderedSupportedLocales,
            })
          : sortDocuments(filteredRows, sort, order);

      return {
        rows: sortedRows.slice(offset, offset + limit),
        total: sortedRows.length,
        limit,
        offset,
      };
    },

    async getOverviewCounts(scope, input) {
      const requestedTypes = [
        ...new Set(input.types.map((type) => type.trim())),
      ];
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        return requestedTypes.map((type) => ({
          type,
          total: 0,
          published: 0,
          drafts: 0,
        }));
      }

      const rows =
        requestedTypes.length === 0
          ? []
          : await db
              .select({
                type: documents.schemaType,
                total: sql<number>`cast(count(*) as integer)`,
                published: sql<number>`cast(count(*) filter (where ${documents.publishedVersion} is not null) as integer)`,
                drafts: sql<number>`cast(count(*) filter (where ${documents.publishedVersion} is null) as integer)`,
              })
              .from(documents)
              .where(
                and(
                  eq(documents.projectId, scopeIds.projectId),
                  eq(documents.environmentId, scopeIds.environmentId),
                  eq(documents.isDeleted, false),
                  inArray(documents.schemaType, requestedTypes),
                ),
              )
              .groupBy(documents.schemaType);

      const countsByType = new Map(
        rows.map((row) => [
          row.type,
          {
            total: row.total,
            published: row.published,
            drafts: row.drafts,
          },
        ]),
      );

      return requestedTypes.map((type) => {
        const counts = countsByType.get(type);

        return {
          type,
          total: counts?.total ?? 0,
          published: counts?.published ?? 0,
          drafts: counts?.drafts ?? 0,
        };
      });
    },

    async getById(scope, documentId, options) {
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        return undefined;
      }

      const row = await resolveHeadRow(scopeIds, normalizedDocumentId);

      if (!row) {
        return undefined;
      }

      if (options?.draft === true) {
        return toContentDocument(scope, row);
      }

      const publishedSnapshot = await resolvePublishedSnapshot(scopeIds, row);

      if (!publishedSnapshot) {
        return undefined;
      }

      return {
        ...publishedSnapshot,
        project: scope.project,
        environment: scope.environment,
      };
    },

    async update(
      scope,
      documentId,
      payload,
      options?: ContentWriteOperationOptions,
    ) {
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const existing = await resolveHeadRow(scopeIds, normalizedDocumentId);

      if (!existing || existing.isDeleted) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const nextType =
        payload.type !== undefined
          ? assertRequiredString(payload.type, "type")
          : existing.schemaType;
      const nextFrontmatter =
        payload.frontmatter !== undefined
          ? assertJsonObject(payload.frontmatter, "frontmatter")
          : (existing.frontmatter as Record<string, unknown>);
      const schema = await resolveTypeSchema(scopeIds, nextType);

      if (!schema) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message: 'Field "type" must reference a synced schema type.',
          statusCode: 400,
          details: {
            field: "type",
            type: nextType,
          },
        });
      }

      await validateReferenceFieldIdentities({
        schema,
        frontmatter: nextFrontmatter,
        lookupTarget: async (candidateDocumentId) => {
          const row = await resolveHeadRow(scopeIds, candidateDocumentId);

          if (!row) {
            return undefined;
          }

          return {
            documentId: row.documentId,
            type: row.schemaType,
            isDeleted: row.isDeleted,
          };
        },
      });
      const { frontmatter: normalizedFrontmatter } =
        await validateMediaFieldIdentities({
          schema,
          frontmatter: nextFrontmatter,
          scope,
          lookupMediaAsset,
        });

      const nextPath =
        payload.path !== undefined
          ? validateContentPath(assertRequiredString(payload.path, "path"))
          : existing.path;
      const nextLocale =
        payload.locale !== undefined
          ? assertRequiredString(payload.locale, "locale")
          : existing.locale;
      const conflict = await findPathConflict(scopeIds, {
        path: nextPath,
        locale: nextLocale,
        documentId: normalizedDocumentId,
      });

      if (conflict) {
        throw new RuntimeError({
          code: "CONTENT_PATH_CONFLICT",
          message:
            "A non-deleted document with the same path and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: conflict.documentId,
            path: nextPath,
            locale: nextLocale,
          },
        });
      }

      const translationConflict = await findTranslationLocaleConflict(
        scopeIds,
        {
          translationGroupId: existing.translationGroupId,
          locale: nextLocale,
          documentId: normalizedDocumentId,
        },
      );

      if (translationConflict) {
        throw new RuntimeError({
          code: "TRANSLATION_VARIANT_CONFLICT",
          message:
            "A non-deleted document with the same translation group and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: translationConflict.documentId,
            translationGroupId: existing.translationGroupId,
            locale: nextLocale,
          },
        });
      }

      try {
        const updated = await db.transaction(async (tx) => {
          await assertExpectedSchemaHash(
            tx as unknown as DrizzleDatabase,
            scope,
            scopeIds,
            options?.expectedSchemaHash,
          );
          const [updated] = await tx
            .update(documents)
            .set({
              path: nextPath,
              schemaType: nextType,
              locale: nextLocale,
              contentFormat:
                payload.format !== undefined
                  ? parseContentFormat(payload.format)
                  : existing.contentFormat,
              frontmatter: normalizedFrontmatter,
              body:
                payload.body !== undefined
                  ? assertRequiredString(payload.body, "body", {
                      allowEmpty: true,
                    })
                  : existing.body,
              hasUnpublishedChanges: true,
              draftRevision: sql`${documents.draftRevision} + 1`,
              updatedBy: payload.updatedBy?.trim() || DEFAULT_ACTOR,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(documents.projectId, scopeIds.projectId),
                eq(documents.environmentId, scopeIds.environmentId),
                eq(documents.documentId, normalizedDocumentId),
                eq(documents.isDeleted, false),
                ...(options?.expectedDraftRevision !== undefined
                  ? [eq(documents.draftRevision, options.expectedDraftRevision)]
                  : []),
              ),
            )
            .returning();

          return updated;
        });

        if (!updated) {
          if (options?.expectedDraftRevision !== undefined) {
            const stillExists = await resolveHeadRow(
              scopeIds,
              normalizedDocumentId,
            );

            if (stillExists && !stillExists.isDeleted) {
              throw new RuntimeError({
                code: "STALE_DRAFT_REVISION",
                message:
                  "Draft has been modified since your last pull. Run 'cms pull' to get the latest version.",
                statusCode: 409,
                details: {
                  documentId: normalizedDocumentId,
                  expectedDraftRevision: options.expectedDraftRevision,
                  currentDraftRevision: Number(stillExists.draftRevision),
                },
              });
            }
          }

          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: normalizedDocumentId,
            },
          });
        }

        return toContentDocument(scope, updated);
      } catch (error) {
        if (isUniqueViolation(error)) {
          const pathConflict = await findPathConflict(scopeIds, {
            path: nextPath,
            locale: nextLocale,
            documentId: normalizedDocumentId,
          });

          if (pathConflict) {
            throw new RuntimeError({
              code: "CONTENT_PATH_CONFLICT",
              message:
                "A non-deleted document with the same path and locale already exists.",
              statusCode: 409,
              details: {
                conflictDocumentId: pathConflict.documentId,
                path: nextPath,
                locale: nextLocale,
              },
            });
          }

          const translationConflict = await findTranslationLocaleConflict(
            scopeIds,
            {
              translationGroupId: existing.translationGroupId,
              locale: nextLocale,
              documentId: normalizedDocumentId,
            },
          );

          if (translationConflict) {
            throw new RuntimeError({
              code: "TRANSLATION_VARIANT_CONFLICT",
              message:
                "A non-deleted document with the same translation group and locale already exists.",
              statusCode: 409,
              details: {
                conflictDocumentId: translationConflict.documentId,
                translationGroupId: existing.translationGroupId,
                locale: nextLocale,
              },
            });
          }

          if (
            getUniqueConstraintName(error) ===
            "uniq_documents_active_translation_locale"
          ) {
            throw new RuntimeError({
              code: "TRANSLATION_VARIANT_CONFLICT",
              message:
                "A non-deleted document with the same translation group and locale already exists.",
              statusCode: 409,
              details: {
                translationGroupId: existing.translationGroupId,
                locale: nextLocale,
              },
            });
          }

          throw new RuntimeError({
            code: "CONTENT_PATH_CONFLICT",
            message:
              "A non-deleted document with the same path and locale already exists.",
            statusCode: 409,
            details: {
              path: nextPath,
              locale: nextLocale,
            },
          });
        }

        throw error;
      }
    },

    async softDelete(scope, documentId) {
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const updated = await db.transaction(async (tx) => {
        const txDb = tx as unknown as DrizzleDatabase;
        const [existing] = await tx
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.projectId, scopeIds.projectId),
              eq(documents.environmentId, scopeIds.environmentId),
              eq(documents.documentId, normalizedDocumentId),
            ),
          )
          .for("update");

        if (!existing) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: normalizedDocumentId,
            },
          });
        }

        const publishedLocale = await resolvePublishedSearchLocale(
          txDb,
          scopeIds,
          existing,
        );
        const [updated] = await tx
          .update(documents)
          .set({
            isDeleted: true,
            hasUnpublishedChanges: true,
            draftRevision: sql`${documents.draftRevision} + 1`,
            updatedBy: DEFAULT_ACTOR,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documents.projectId, scopeIds.projectId),
              eq(documents.environmentId, scopeIds.environmentId),
              eq(documents.documentId, normalizedDocumentId),
            ),
          )
          .returning();

        if (!updated) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: normalizedDocumentId,
            },
          });
        }

        await searchBackend.removePublishedDocument(txDb, {
          projectId: scopeIds.projectId,
          environmentId: scopeIds.environmentId,
          documentId: normalizedDocumentId,
          locale: publishedLocale,
        });

        return updated;
      });

      return toContentDocument(scope, updated);
    },

    async restore(scope, documentId) {
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const existing = await resolveHeadRow(scopeIds, normalizedDocumentId);

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const conflict = await findPathConflict(scopeIds, {
        path: existing.path,
        locale: existing.locale,
        documentId: normalizedDocumentId,
      });

      if (conflict) {
        throw buildContentPathConflict({
          conflictDocumentId: conflict.documentId,
          path: existing.path,
          locale: existing.locale,
        });
      }

      if (!existing.isDeleted) {
        return toContentDocument(scope, existing);
      }

      const updated = await db.transaction(async (tx) => {
        const txDb = tx as unknown as DrizzleDatabase;
        const [restored] = await tx
          .update(documents)
          .set({
            isDeleted: false,
            updatedBy: DEFAULT_ACTOR,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documents.projectId, scopeIds.projectId),
              eq(documents.environmentId, scopeIds.environmentId),
              eq(documents.documentId, normalizedDocumentId),
            ),
          )
          .returning();

        if (!restored) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: normalizedDocumentId,
            },
          });
        }

        await upsertPublishedSearchDocument(txDb, scopeIds, restored);

        return restored;
      });

      return toContentDocument(scope, updated);
    },

    async listVersions(scope, documentId, query) {
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const limit = parsePositiveInt(query.limit, "limit", {
        defaultValue: DEFAULT_LIMIT,
        min: 1,
        max: MAX_LIMIT,
      });
      const offset = parsePositiveInt(query.offset, "offset", {
        defaultValue: 0,
        min: 0,
      });
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const existing = await resolveHeadRow(scopeIds, normalizedDocumentId);

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const rows = await db
        .select()
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.projectId, scopeIds.projectId),
            eq(documentVersions.environmentId, scopeIds.environmentId),
            eq(documentVersions.documentId, normalizedDocumentId),
          ),
        );

      const sortedRows = rows.sort(
        (left, right) => right.version - left.version,
      );

      return {
        rows: sortedRows
          .slice(offset, offset + limit)
          .map((row) => toContentVersionDocument(scope, row)),
        total: sortedRows.length,
        limit,
        offset,
      };
    },

    async getVersion(scope, documentId, version) {
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const existing = await resolveHeadRow(scopeIds, normalizedDocumentId);

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const versionRow = await resolveVersionRow(
        scopeIds,
        normalizedDocumentId,
        version,
      );

      if (!versionRow) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Version not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
            version,
          },
        });
      }

      return toContentVersionDocument(scope, versionRow);
    },

    async restoreVersion(scope, documentId, version, input) {
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const existing = await resolveHeadRow(scopeIds, normalizedDocumentId);

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const versionRow = await resolveVersionRow(
        scopeIds,
        normalizedDocumentId,
        version,
      );

      if (!versionRow) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Version not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
            version,
          },
        });
      }

      const conflict = await findPathConflict(scopeIds, {
        path: versionRow.path,
        locale: versionRow.locale,
        documentId: normalizedDocumentId,
      });

      if (conflict) {
        throw buildContentPathConflict({
          conflictDocumentId: conflict.documentId,
          path: versionRow.path,
          locale: versionRow.locale,
        });
      }

      const actorId = input.actorId?.trim() || DEFAULT_ACTOR;
      const restoredDocument = await db.transaction(async (tx) => {
        const txDb = tx as unknown as DrizzleDatabase;
        const baseUpdate = {
          path: versionRow.path,
          schemaType: versionRow.schemaType,
          locale: versionRow.locale,
          contentFormat: versionRow.contentFormat as ContentFormat,
          frontmatter: versionRow.frontmatter as Record<string, unknown>,
          body: versionRow.body,
          isDeleted: false,
          draftRevision: existing.draftRevision + 1,
          updatedBy: actorId,
          updatedAt: new Date(),
        };

        if (input.targetStatus === "published") {
          const nextVersion = await getNextVersionNumber(
            txDb,
            normalizedDocumentId,
          );

          await insertPublishedVersionRow(txDb, {
            headRow: existing,
            snapshot: {
              path: versionRow.path,
              type: versionRow.schemaType,
              locale: versionRow.locale,
              format: versionRow.contentFormat as ContentFormat,
              frontmatter: versionRow.frontmatter as Record<string, unknown>,
              body: versionRow.body,
            },
            version: nextVersion,
            actorId,
            changeSummary: input.changeSummary,
          });

          const [updated] = await tx
            .update(documents)
            .set({
              ...baseUpdate,
              publishedVersion: nextVersion,
              hasUnpublishedChanges: false,
            })
            .where(
              and(
                eq(documents.projectId, scopeIds.projectId),
                eq(documents.environmentId, scopeIds.environmentId),
                eq(documents.documentId, normalizedDocumentId),
              ),
            )
            .returning();

          if (!updated) {
            throw new RuntimeError({
              code: "NOT_FOUND",
              message: "Document not found.",
              statusCode: 404,
              details: {
                documentId: normalizedDocumentId,
              },
            });
          }

          return updated;
        }

        const [updated] = await tx
          .update(documents)
          .set({
            ...baseUpdate,
            hasUnpublishedChanges: true,
          })
          .where(
            and(
              eq(documents.projectId, scopeIds.projectId),
              eq(documents.environmentId, scopeIds.environmentId),
              eq(documents.documentId, normalizedDocumentId),
            ),
          )
          .returning();

        if (!updated) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: normalizedDocumentId,
            },
          });
        }

        await upsertPublishedSearchDocument(txDb, scopeIds, updated);

        return updated;
      });

      return toContentDocument(scope, restoredDocument);
    },

    async publish(scope, documentId, input) {
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const existing = await db.query.documents.findFirst({
        where: and(
          eq(documents.projectId, scopeIds.projectId),
          eq(documents.environmentId, scopeIds.environmentId),
          eq(documents.documentId, normalizedDocumentId),
          eq(documents.isDeleted, false),
        ),
      });

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const actorId = input.actorId?.trim() || DEFAULT_ACTOR;
      const publishedDocument = await db.transaction(async (tx) => {
        const nextVersion = await getNextVersionNumber(
          tx as unknown as DrizzleDatabase,
          normalizedDocumentId,
        );

        await insertPublishedVersionRow(tx as unknown as DrizzleDatabase, {
          headRow: existing,
          snapshot: {
            path: existing.path,
            type: existing.schemaType,
            locale: existing.locale,
            format: existing.contentFormat as ContentFormat,
            frontmatter: existing.frontmatter as Record<string, unknown>,
            body: existing.body,
          },
          version: nextVersion,
          actorId,
          changeSummary: input.changeSummary,
        });

        const [updated] = await tx
          .update(documents)
          .set({
            publishedVersion: nextVersion,
            hasUnpublishedChanges: false,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documents.projectId, scopeIds.projectId),
              eq(documents.environmentId, scopeIds.environmentId),
              eq(documents.documentId, normalizedDocumentId),
            ),
          )
          .returning();

        if (!updated) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: normalizedDocumentId,
            },
          });
        }

        return updated;
      });

      return toContentDocument(scope, publishedDocument);
    },

    async unpublish(scope, documentId, input) {
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const actorId = input.actorId?.trim() || DEFAULT_ACTOR;
      const updated = await db.transaction(async (tx) => {
        const txDb = tx as unknown as DrizzleDatabase;
        const [existing] = await tx
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.projectId, scopeIds.projectId),
              eq(documents.environmentId, scopeIds.environmentId),
              eq(documents.documentId, normalizedDocumentId),
              eq(documents.isDeleted, false),
            ),
          )
          .for("update");

        if (!existing) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: normalizedDocumentId,
            },
          });
        }

        const publishedLocale = await resolvePublishedSearchLocale(
          txDb,
          scopeIds,
          existing,
        );
        const [updated] = await tx
          .update(documents)
          .set({
            publishedVersion: null,
            hasUnpublishedChanges: true,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documents.projectId, scopeIds.projectId),
              eq(documents.environmentId, scopeIds.environmentId),
              eq(documents.documentId, normalizedDocumentId),
              eq(documents.isDeleted, false),
            ),
          )
          .returning();

        if (!updated) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: normalizedDocumentId,
            },
          });
        }

        await searchBackend.removePublishedDocument(txDb, {
          projectId: scopeIds.projectId,
          environmentId: scopeIds.environmentId,
          documentId: normalizedDocumentId,
          locale: publishedLocale,
        });

        return updated;
      });

      return toContentDocument(scope, updated);
    },

    async listVariants(scope, documentId) {
      const scopeIds = await resolveScopeIds(scope, false);

      if (!scopeIds) {
        return undefined;
      }

      const doc = await db.query.documents.findFirst({
        where: and(
          eq(documents.projectId, scopeIds.projectId),
          eq(documents.environmentId, scopeIds.environmentId),
          eq(documents.documentId, documentId),
        ),
      });

      if (!doc || doc.isDeleted) {
        return undefined;
      }

      const rows = await db.query.documents.findMany({
        where: and(
          eq(documents.projectId, scopeIds.projectId),
          eq(documents.environmentId, scopeIds.environmentId),
          eq(documents.translationGroupId, doc.translationGroupId),
          eq(documents.isDeleted, false),
        ),
      });

      return sortVariantSummaries(
        rows.map((row) => ({
          documentId: row.documentId,
          locale: row.locale,
          path: row.path,
          publishedVersion: row.publishedVersion,
          hasUnpublishedChanges: row.hasUnpublishedChanges,
        })),
      );
    },
  };
}
